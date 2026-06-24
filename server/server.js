/**
 * server.js
 * 漆彈大亂鬥多人連線伺服端主入口點。
 * 負責 Express 靜態檔案服務與 Socket.io 事件分配與房間生命週期管理。
 * 使用 ES6+ 語法與中文註解。
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const { GameRoom, generateRoomId } = require('./game/GameRoom');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // 允許所有來源連線，便於部署與本機測試
        methods: ["GET", "POST"]
    }
});

const PORT = 3000;

// 提供前端靜態檔案服務 (指向 ../client 目錄)
app.use(express.static(path.join(__dirname, '../client')));

// Fallback 路由
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

// 管理所有房間的 Map (Key: roomId, Value: GameRoom 實例)
const rooms = new Map();

// 監聽 Socket 連線
io.on('connection', (socket) => {
    console.log(`[連線] 玩家已連線：${socket.id}`);
    
    // 記錄此連線所在的房間 ID
    socket.roomId = null;

    /**
     * 處理加入房間請求
     * 格式：{ roomId, playerName, classType }
     */
    socket.on('join_room', (data) => {
        try {
            let { roomId, playerName, classType, password } = data;
            password = password || '';
            playerName = playerName || '未命名玩家';
            classType = classType || 'rifle';

            let room;

            // 1. 決定或建立房間
            if (roomId && roomId.trim().length > 0) {
                const targetId = roomId.trim().toUpperCase();
                if (rooms.has(targetId)) {
                    room = rooms.get(targetId);
                    // 加入現有房間 → 驗證密碼
                    if (!room.checkPassword(password)) {
                        socket.emit('error', { message: '❌ 房間密碼錯誤！' });
                        return;
                    }
                } else {
                    // 建立指定 ID 的房間，並設密碼
                    room = new GameRoom(targetId, password);
                    rooms.set(targetId, room);
                    console.log(`[房間] 建立指定房號房間：${targetId}${password ? '（已設定密碼）' : ''}`);
                }
            } else {
                // 隨機 ID 建立房間（可選密碼）
                let newId;
                do {
                    newId = generateRoomId();
                } while (rooms.has(newId));
                
                room = new GameRoom(newId, password);
                rooms.set(newId, room);
                console.log(`[房間] 建立隨機房號房間：${newId}${password ? '（已設定密碼）' : ''}`);
            }

            // 2. 將玩家加入該房間
            // addPlayer 會處理人數上限、遊戲進行狀態與隊伍平衡
            const player = room.addPlayer(socket.id, playerName, classType);

            // 3. 設定 Socket 狀態與加入 Socket.io 房間
            socket.roomId = room.id;
            socket.join(room.id);

            console.log(`[房間] 玩家 ${playerName}(${socket.id}) 加入房間 ${room.id}，分配至 ${player.team === 'red' ? '紅隊' : '藍隊'}`);

            // 4. 回傳加入成功事件給當前玩家
            socket.emit('room_joined', {
                roomId: room.id,
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    classType: p.classType,
                    team: p.team
                })),
                playerId: socket.id
            });

            // 5. 廣播給房間內其他玩家有新隊友加入
            socket.to(room.id).emit('player_joined', {
                id: player.id,
                name: player.name,
                classType: player.classType,
                team: player.team
            });

            // 6. 如果房間達滿員 4 人，自動開始遊戲
            if (room.players.length === 4) {
                console.log(`[遊戲] 房間 ${room.id} 已滿 4 人，自動開始遊戲！`);
                room.startGame(io);
            }

        } catch (err) {
            console.error(`[錯誤] 加入房間失敗：`, err.message);
            socket.emit('error', { message: err.message });
        }
    });

    /**
     * 處理玩家輸入更新 (高頻率事件)
     * 格式：{ moveX, moveY, aimAngle, isFiring, useSkill }
     */
    socket.on('player_input', (inputData) => {
        const roomId = socket.roomId;
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (room && room.gameInProgress && room.gameLoop) {
            room.gameLoop.handleInput(socket.id, inputData);
        }
    });

    /**
     * 處理手動開始遊戲 (僅限房主)
     */
    socket.on('start_game', () => {
        const roomId = socket.roomId;
        if (!roomId) {
            socket.emit('error', { message: '您未在任何房間中' });
            return;
        }

        const room = rooms.get(roomId);
        if (!room) return;

        // 檢查權限：只有房主能開始遊戲
        if (room.hostId !== socket.id) {
            socket.emit('error', { message: '只有房主可以開始遊戲' });
            return;
        }

        if (room.gameInProgress) {
            socket.emit('error', { message: '遊戲已經開始了' });
            return;
        }

        console.log(`[遊戲] 房主 ${socket.id} 啟動房間 ${room.id} 的遊戲！`);
        room.startGame(io);
    });

    /**
     * 處理主動離開房間
     */
    socket.on('leave_room', () => {
        handlePlayerDeparture(socket);
    });

    /**
     * 處理連線中斷
     */
    socket.on('disconnect', () => {
        console.log(`[離線] 玩家已中斷連線：${socket.id}`);
        handlePlayerDeparture(socket);
    });
});

/**
 * 玩家離開房務之共用處理邏輯
 * @param {Object} socket 當前的 Socket 連線實例
 */
function handlePlayerDeparture(socket) {
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // 1. 從房間中移除玩家
    const result = room.removePlayer(socket.id);
    
    // 2. 退出 Socket 房間
    socket.leave(roomId);
    socket.roomId = null;

    console.log(`[房間] 玩家 ${socket.id} 離開房間 ${roomId}`);

    // 3. 廣播玩家離開事件給該房間的其他人
    io.to(roomId).emit('player_left', { id: socket.id });

    // 4. 若房間已空無一人，銷毀房間釋放記憶體
    if (result.isEmpty) {
        rooms.delete(roomId);
        console.log(`[房間] 房間 ${roomId} 空無一人，已成功銷毀。`);
    } else {
        console.log(`[房間] 房間 ${roomId} 剩餘玩家數：${room.players.length}。房主現在是：${room.hostId}`);
    }
}

// 啟動伺服器監聽
server.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` 漆彈大亂鬥多人伺服器已成功啟動！`);
    console.log(` 正在監聽連接埠：${PORT}`);
    console.log(` 靜態服務路徑：${path.join(__dirname, '../client')}`);
    console.log(` 本機存取網址：http://localhost:${PORT}`);
    console.log(`===================================================`);
});

/**
 * GameRoom.js
 * 房間管理類別，處理玩家加入、離開、隊伍平衡分配、房主變更以及遊戲開始的流程。
 * 使用 ES6+ 語法與中文註解。
 */

const { Player } = require('./Player');
const GameLoop = require('./GameLoop');

// 生成 4 碼隨機字母與數字組成的房間 ID
function generateRoomId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

class GameRoom {
    constructor(id, password = '') {
        this.id = id;
        this.password = password;      // 房間密碼（空字串 = 無密碼）
        this.players = [];            // 儲存 Player 實例的陣列
        this.gameInProgress = false;   // 遊戲是否進行中
        this.hostId = null;           // 房主的 socket.id
        this.gameLoop = null;         // 該房間獨立的 GameLoop 實例
    }

    /**
     * 驗證房間密碼
     */
    checkPassword(inputPwd) {
        return this.password === '' || this.password === inputPwd;
    }

    /**
     * 玩家加入房間
     * @param {string} socketId 玩家的 Socket ID
     * @param {string} name 玩家名稱
     * @param {string} classType 職業類型
     * @returns {Player} 回傳建立的玩家實例
     */
    addPlayer(socketId, name, classType) {
        if (this.players.length >= 4) {
            throw new Error('房間人數已滿 (最多 4 人)');
        }
        if (this.gameInProgress) {
            throw new Error('遊戲已在進行中，無法加入');
        }

        // 隊伍平衡機制：計算紅藍兩隊當前人數，新玩家加入人數少的那一隊
        let redCount = 0;
        let blueCount = 0;
        this.players.forEach(p => {
            if (p.team === 'red') redCount++;
            if (p.team === 'blue') blueCount++;
        });

        // 預設紅隊人數 <= 藍隊時加入紅隊，否則加入藍隊
        const team = redCount <= blueCount ? 'red' : 'blue';

        // 初始座標 (在 GameLoop 開始時會根據隊伍被重設)
        const spawnX = team === 'red' ? 150 : 2250;
        const spawnY = 800; // 地圖高度中點預設

        const player = new Player(socketId, name, classType, team, spawnX, spawnY);
        this.players.push(player);

        // 如果是第一個加入的玩家，設為房主
        if (this.players.length === 1) {
            this.hostId = socketId;
        }

        return player;
    }

    /**
     * 玩家離開房間
     * @param {string} socketId 玩家的 Socket ID
     * @returns {Object} 包含房間當前狀態的資訊 (是否空房等)
     */
    removePlayer(socketId) {
        const index = this.players.findIndex(p => p.id === socketId);
        if (index === -1) return { isEmpty: this.players.length === 0 };

        this.players.splice(index, 1);

        // 如果離開的是房主，重新指派房主
        if (this.hostId === socketId && this.players.length > 0) {
            this.hostId = this.players[0].id;
        }

        // 如果遊戲正在進行，且玩家離開，可能需要讓 GameLoop 處理玩家離開
        if (this.gameLoop) {
            this.gameLoop.removePlayer(socketId);
        }

        // 如果房間沒有玩家了，銷毀 GameLoop
        if (this.players.length === 0) {
            this.destroy();
            return { isEmpty: true };
        }

        return { isEmpty: false, newHostId: this.hostId };
    }

    /**
     * 開始遊戲倒數
     * @param {Object} io Socket.io 的伺服器實例
     */
    startGame(io) {
        if (this.gameInProgress) return;
        this.gameInProgress = true;

        // 初始化每個房間獨立的 GameLoop
        this.gameLoop = new GameLoop(this.id, this.players, io, () => {
            // 遊戲結束時的回呼函式 (Callback)
            this.gameInProgress = false;
            this.gameLoop = null;
        });

        // 廣播 game_start 事件，倒數 3 秒
        io.to(this.id).emit('game_start', { countdown: 3 });

        // 3 秒後正式啟動遊戲主迴圈
        setTimeout(() => {
            if (this.gameLoop) {
                this.gameLoop.start();
            }
        }, 3000);
    }

    /**
     * 銷毀房間與釋放資源
     */
    destroy() {
        if (this.gameLoop) {
            this.gameLoop.stop();
            this.gameLoop = null;
        }
        this.players = [];
        this.gameInProgress = false;
    }
}

module.exports = {
    GameRoom,
    generateRoomId
};

/**
 * GameLoop.js
 * 伺服器端核心 60fps 遊戲主迴圈。
 * 處理玩家移動（含滑牆碰撞）、子彈生成與模擬、傷害判定、大招物理與塗地格線計算。
 * 使用 ES6+ 語法與中文註解。
 */

// 地圖常數
const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1600;
const GRID_SIZE = 40; // 40x40 像素一格
const COLS = WORLD_WIDTH / GRID_SIZE; // 60
const ROWS = WORLD_HEIGHT / GRID_SIZE; // 40
const TOTAL_GRIDS = COLS * ROWS; // 2400

// 對稱的障礙物配置 (矩形: { x, y, w, h })
const OBSTACLES = [
    { x: 1100, y: 700, w: 200, h: 200 },    // 中央大障礙物
    { x: 400, y: 300, w: 150, h: 100 },     // 左上
    { x: 400, y: 1200, w: 150, h: 100 },    // 左下
    { x: 1850, y: 300, w: 150, h: 100 },    // 右上
    { x: 1850, y: 1200, w: 150, h: 100 },   // 右下
    { x: 1100, y: 200, w: 200, h: 80 },     // 中央上方
    { x: 1100, y: 1320, w: 200, h: 80 }     // 中央下方
];

// 職業基礎屬性 (複寫自 Player.js 用於子彈計算)
const BULLET_PROFILES = {
    rifle: { speed: 12, damage: 18, range: 480, radius: 8, paintRadius: 28 },
    tank: { speed: 10, damage: 14, range: 320, radius: 10, paintRadius: 36 },
    sniper: { speed: 22, damage: 65, range: 900, radius: 6, paintRadius: 22 },
    knife: { speed: 6, damage: 40, range: 110, radius: 24, paintRadius: 65 } // 滾刷劈出的墨水波
};

class GameLoop {
    constructor(roomId, players, io, onGameOver) {
        this.roomId = roomId;
        this.players = players;       // 玩家 Player 實例陣列
        this.io = io;
        this.onGameOver = onGameOver; // 遊戲結束回呼
        
        this.bullets = [];            // 子彈清單
        this.missiles = [];           // 多重導彈清單 (步槍大招)
        
        // 油漆網格系統：儲存每個格子的佔領狀態 (null, 'red', 'blue')
        this.inkGrid = new Array(TOTAL_GRIDS).fill(null);
        
        this.gameTime = 180;          // 3 分鐘 (180 秒)
        this.scores = { red: '0.0', blue: '0.0' };
        
        // 戰績統計資訊
        this.stats = {};
        this.players.forEach(p => {
            this.stats[p.id] = {
                id: p.id,
                name: p.name,
                team: p.team,
                classType: p.classType,
                kills: 0,
                deaths: 0
            };
        });

        // 計時器 ID
        this.loopInterval = null;
        this.timerInterval = null;
    }

    /**
     * 啟動遊戲迴圈與時間倒數
     */
    start() {
        // 1. 初始化玩家出生位置
        let redIndex = 0;
        let blueIndex = 0;
        
        this.players.forEach(player => {
            player.lastInput = { moveX: 0, moveY: 0, aimAngle: 0, isFiring: false, useSkill: false };
            if (player.team === 'red') {
                player.respawn(200, 400 + redIndex * 200);
                redIndex++;
            } else {
                player.respawn(WORLD_WIDTH - 200, 400 + blueIndex * 200);
                blueIndex++;
            }
        });

        // 2. 清空網格與實體
        this.inkGrid.fill(null);
        this.bullets = [];
        this.missiles = [];
        this.scores = { red: '0.0', blue: '0.0' };
        this.gameTime = 180;

        // 3. 啟動 1 秒的定時計時器 (倒數時間與計算佔領百分比)
        this.timerInterval = setInterval(() => {
            this.gameTime--;
            this.calculateScores();

            if (this.gameTime <= 0) {
                this.endGame();
            }
        }, 1000);

        // 4. 啟動 60fps 遊戲主迴圈 (每 16.67 毫秒更新一次)
        this.loopInterval = setInterval(() => {
            this.tick();
        }, 1000 / 60);
    }

    /**
     * 停止遊戲迴圈
     */
    stop() {
        if (this.loopInterval) clearInterval(this.loopInterval);
        if (this.timerInterval) clearInterval(this.timerInterval);
    }

    /**
     * 移除離開的玩家
     */
    removePlayer(socketId) {
        // 如果有玩家中途斷線，這裡會被呼叫
        // 戰績中保留，但從玩家更新列表中移除
    }

    /**
     * 接收並儲存玩家的最新輸入
     */
    handleInput(socketId, inputData) {
        const player = this.players.find(p => p.id === socketId);
        if (player && !player.isDead) {
            player.lastInput = inputData;
        }
    }

    /**
     * 檢測圓形與障礙物(矩形)的碰撞
     */
    checkObstacleCollision(x, y, radius) {
        for (const rect of OBSTACLES) {
            const closestX = Math.max(rect.x, Math.min(x, rect.x + rect.w));
            const closestY = Math.max(rect.y, Math.min(y, rect.y + rect.h));
            const dx = x - closestX;
            const dy = y - closestY;
            if (dx * dx + dy * dy < radius * radius) {
                return true; // 發生碰撞
            }
        }
        return false;
    }

    /**
     * 塗色格線計算
     */
    paintSplat(x, y, radius, team) {
        const minCol = Math.max(0, Math.floor((x - radius) / GRID_SIZE));
        const maxCol = Math.min(COLS - 1, Math.floor((x + radius) / GRID_SIZE));
        const minRow = Math.max(0, Math.floor((y - radius) / GRID_SIZE));
        const maxRow = Math.min(ROWS - 1, Math.floor((y + radius) / GRID_SIZE));
        const radiusSq = radius * radius;

        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                const gx = c * GRID_SIZE + GRID_SIZE / 2;
                const gy = r * GRID_SIZE + GRID_SIZE / 2;
                const dx = gx - x;
                const dy = gy - y;
                if (dx * dx + dy * dy <= radiusSq) {
                    this.inkGrid[r * COLS + c] = team;
                }
            }
        }

        // 廣播給所有客戶端在畫布上渲染墨水噴濺效果
        this.io.to(this.roomId).emit('ink_splat', { x, y, radius, team });
    }

    /**
     * 計算塗地百分比得分
     */
    calculateScores() {
        let redCount = 0;
        let blueCount = 0;
        for (let i = 0; i < TOTAL_GRIDS; i++) {
            if (this.inkGrid[i] === 'red') redCount++;
            else if (this.inkGrid[i] === 'blue') blueCount++;
        }

        this.scores.red = ((redCount / TOTAL_GRIDS) * 100).toFixed(1);
        this.scores.blue = ((blueCount / TOTAL_GRIDS) * 100).toFixed(1);
    }

    /**
     * 發射普通攻擊子彈
     */
    fireBullet(player, angle) {
        const profile = BULLET_PROFILES[player.classType];
        if (!profile) return;

        player.shootTimer = player.classType === 'rifle' ? 5 : 
                            player.classType === 'tank' ? 8 : 
                            player.classType === 'sniper' ? 24 : 18;

        const baseBullet = {
            id: Math.random().toString(36).substring(2, 9),
            playerId: player.id,
            team: player.team,
            type: player.classType,
            damage: profile.damage,
            range: profile.range,
            radius: profile.radius,
            paintRadius: profile.paintRadius,
            traveled: 0
        };

        if (player.classType === 'tank') {
            // 坦克散彈：一次發射三發，角度稍微擴散
            const angles = [angle - 0.22, angle, angle + 0.22]; // 約散開 12.6 度
            angles.forEach(ang => {
                const bullet = {
                    ...baseBullet,
                    id: Math.random().toString(36).substring(2, 9),
                    x: player.x + Math.cos(ang) * 22,
                    y: player.y + Math.sin(ang) * 22,
                    vx: Math.cos(ang) * profile.speed,
                    vy: Math.sin(ang) * profile.speed
                };
                this.bullets.push(bullet);
                this.io.to(this.roomId).emit('bullet_spawn', {
                    x: bullet.x, y: bullet.y, vx: bullet.vx, vy: bullet.vy, team: bullet.team, type: bullet.type
                });
            });
        } else {
            // 步槍、狙擊槍、滾刷
            const bullet = {
                ...baseBullet,
                x: player.x + Math.cos(angle) * 22,
                y: player.y + Math.sin(angle) * 22,
                vx: Math.cos(angle) * profile.speed,
                vy: Math.sin(angle) * profile.speed
            };
            this.bullets.push(bullet);
            this.io.to(this.roomId).emit('bullet_spawn', {
                x: bullet.x, y: bullet.y, vx: bullet.vx, vy: bullet.vy, team: bullet.team, type: bullet.type
            });
        }
    }

    /**
     * 執行大招邏輯
     */
    castSpecialSkill(player) {
        player.useSkill(); // 重設冷卻

        const skillType = player.classType;
        const data = {};

        if (skillType === 'rifle') {
            // 1. 步槍：多重導彈
            // 尋找所有敵方玩家作為目標，若無敵方，隨機生成位置
            const enemies = this.players.filter(p => p.team !== player.team && !p.isDead);
            const targets = [];
            
            for (let i = 0; i < 4; i++) {
                if (enemies.length > 0) {
                    const targetEnemy = enemies[i % enemies.length];
                    // 加上一點隨機偏誤，讓導彈有些許偏差
                    targets.push({
                        x: targetEnemy.x + (Math.random() - 0.5) * 60,
                        y: targetEnemy.y + (Math.random() - 0.5) * 60
                    });
                } else {
                    // 沒敵人時，炸自己對側的隨機區塊
                    targets.push({
                        x: player.team === 'red' ? 1400 + Math.random() * 800 : 200 + Math.random() * 800,
                        y: 100 + Math.random() * 1400
                    });
                }
            }

            targets.forEach(tgt => {
                this.missiles.push({
                    x: player.x,
                    y: player.y,
                    targetX: tgt.x,
                    targetY: tgt.y,
                    timer: 120, // 2 秒後落地 (120 幀)
                    team: player.team,
                    playerId: player.id
                });
            });
            data.targets = targets;

        } else if (skillType === 'tank') {
            // 2. 坦克：鯊魚坐騎
            // 玩家朝當前瞄準角度衝刺，設定無敵與衝刺計時
            player.sharkRideTimer = 90; // 1.5 秒
            player.sharkRideAngle = player.angle;
            data.angle = player.angle;

        } else if (skillType === 'sniper') {
            // 3. 狙擊：貫穿極光
            // 瞬間對直線上的敵人造成傷害，並留下長條油漆路徑
            const startX = player.x;
            const startY = player.y;
            const laserAngle = player.angle;
            const maxLaserLength = 3000;
            const laserWidth = 80;
            const laserHalfWidth = laserWidth / 2;

            const cosA = Math.cos(laserAngle);
            const sinA = Math.sin(laserAngle);

            // 傷害檢測
            this.players.forEach(enemy => {
                if (enemy.team === player.team || enemy.isDead || enemy.isInvulnerable) return;

                // 計算敵方到雷射射線的垂直投影距離
                const dx = enemy.x - startX;
                const dy = enemy.y - startY;
                const projection = dx * cosA + dy * sinA; // 射線上的長度 t

                if (projection >= 0 && projection <= maxLaserLength) {
                    // 垂直向量距離
                    const perpX = dx - projection * cosA;
                    const perpY = dy - projection * sinA;
                    const distSq = perpX * perpX + perpY * perpY;

                    // 敵方半徑約為 20
                    if (distSq <= (laserHalfWidth + 20) * (laserHalfWidth + 20)) {
                        this.damagePlayer(enemy, 120, player.id);
                    }
                }
            });

            // 沿射線繪製長條油漆
            for (let d = 40; d < maxLaserLength; d += 60) {
                const px = startX + cosA * d;
                const py = startY + sinA * d;
                // 檢查是否超出地圖
                if (px < 0 || px > WORLD_WIDTH || py < 0 || py > WORLD_HEIGHT) break;
                // 檢查是否撞到障礙物 (極光在前端通常可以穿牆或止於牆面，規格沒寫，我們讓它塗地穿透，但可被障礙物擋住子彈)
                // 這裡採用極光直接貫穿塗墨，符合大招的霸氣
                this.paintSplat(px, py, 60, player.team);
            }

            data.x = startX;
            data.y = startY;
            data.angle = laserAngle;

        } else if (skillType === 'knife') {
            // 4. 滾刷：凌空墜擊
            // 玩家騰空，進入無敵無法移動狀態，1.5 秒後在原地引發重砸巨爆
            player.splashdownTimer = 90; // 1.5 秒
            data.x = player.x;
            data.y = player.y;
        }

        // 廣播給所有玩家施放技能的特效
        this.io.to(this.roomId).emit('special_used', {
            playerId: player.id,
            skillType,
            data
        });
    }

    /**
     * 處理玩家受傷
     */
    damagePlayer(victim, damage, attackerId) {
        if (victim.isDead || victim.isInvulnerable) return;

        const isKilled = victim.takeDamage(damage);
        
        // 廣播受傷事件
        this.io.to(this.roomId).emit('player_damaged', {
            id: victim.id,
            hp: victim.hp,
            attackerId
        });

        if (isKilled) {
            // 更新戰績
            if (this.stats[attackerId]) this.stats[attackerId].kills++;
            if (this.stats[victim.id]) this.stats[victim.id].deaths++;

            // 廣播擊倒訊息 (可在前端彈出廣播，後端跟隨發送)
            this.io.to(this.roomId).emit('player_damaged', {
                id: victim.id,
                hp: 0,
                attackerId
            });
        }
    }

    /**
     * 每幀核心更新計時 (60fps)
     */
    tick() {
        // 1. 更新所有玩家
        this.players.forEach(player => {
            player.update(); // 遞減冷卻與狀態計時

            if (player.isDead) {
                // 如果死亡，檢查是否重生
                if (player.respawnTimer <= 0) {
                    let rx = 200, ry = 800;
                    const idx = this.players.filter(p => p.team === player.team).indexOf(player);
                    if (player.team === 'red') {
                        rx = 200;
                        ry = 400 + idx * 200;
                    } else {
                        rx = WORLD_WIDTH - 200;
                        ry = 400 + idx * 200;
                    }
                    player.respawn(rx, ry);
                }
                return; // 死亡玩家不處理輸入與大招
            }

            const input = player.lastInput || { moveX: 0, moveY: 0, aimAngle: 0, isFiring: false, useSkill: false };
            player.angle = input.aimAngle;

            // 特殊狀態下的移動控制
            if (player.sharkRideTimer > 0) {
                // 坦克大招：鯊魚衝刺
                // 自動以超高速直線前進
                player.vx = Math.cos(player.sharkRideAngle) * player.baseSpeed * 2.8;
                player.vy = Math.sin(player.sharkRideAngle) * player.baseSpeed * 2.8;

                // 衝刺期間留下油漆
                if (player.sharkRideTimer % 3 === 0) {
                    this.paintSplat(player.x, player.y, 45, player.team);
                }

                // 檢查是否撞到牆面或衝刺結束，若撞牆提早爆炸
                const nextX = player.x + player.vx;
                const nextY = player.y + player.vy;
                const hasWallCollision = this.checkObstacleCollision(nextX, nextY, 20) || 
                                         nextX < 20 || nextX > WORLD_WIDTH - 20 ||
                                         nextY < 20 || nextY > WORLD_HEIGHT - 20;

                if (hasWallCollision || player.sharkRideTimer === 1) {
                    // 結束衝刺，引發巨爆
                    player.sharkRideTimer = 0;
                    player.vx = 0;
                    player.vy = 0;
                    
                    // 造成爆炸傷害與塗地
                    this.players.forEach(enemy => {
                        if (enemy.team === player.team || enemy.isDead || enemy.isInvulnerable) return;
                        const distSq = (enemy.x - player.x) * (enemy.x - player.x) + (enemy.y - player.y) * (enemy.y - player.y);
                        if (distSq <= 180 * 180) { // 爆炸半徑 180
                            this.damagePlayer(enemy, 100, player.id);
                        }
                    });
                    this.paintSplat(player.x, player.y, 150, player.team); // 塗地半徑 150
                } else {
                    // 移動玩家
                    player.x = nextX;
                    player.y = nextY;
                }

            } else if (player.splashdownTimer > 0) {
                // 滾刷大招：凌空墜擊
                player.vx = 0;
                player.vy = 0;

                // 當倒數計時剛好減至 1 時觸發落地重砸
                if (player.splashdownTimer === 1) {
                    this.players.forEach(enemy => {
                        if (enemy.team === player.team || enemy.isDead || enemy.isInvulnerable) return;
                        const distSq = (enemy.x - player.x) * (enemy.x - player.x) + (enemy.y - player.y) * (enemy.y - player.y);
                        if (distSq <= 200 * 200) { // 爆炸半徑 200
                            this.damagePlayer(enemy, 110, player.id);
                        }
                    });
                    this.paintSplat(player.x, player.y, 160, player.team); // 塗地半徑 160
                }

            } else {
                // 正常玩家輸入移動控制
                player.vx = input.moveX * player.speed;
                player.vy = input.moveY * player.speed;

                // 分軸滑牆碰撞檢測，提供極佳的滑牆移動手感
                const tempX = player.x + player.vx;
                if (tempX >= 20 && tempX <= WORLD_WIDTH - 20 && !this.checkObstacleCollision(tempX, player.y, 20)) {
                    player.x = tempX;
                }
                const tempY = player.y + player.vy;
                if (tempY >= 20 && tempY <= WORLD_HEIGHT - 20 && !this.checkObstacleCollision(player.x, tempY, 20)) {
                    player.y = tempY;
                }

                // 處理普通攻擊
                if (input.isFiring) {
                    if (player.classType === 'sniper') {
                        // 狙擊槍：按下蓄力
                        if (player.chargeProgress < 100 && player.shootTimer === 0) {
                            player.chargeProgress += 1.8; // 約 1 秒 (55 幀) 蓄力滿
                        }
                    } else if (player.shootTimer === 0) {
                        // 步槍、坦克、滾刷：冷卻到即發射
                        this.fireBullet(player, player.angle);
                    }
                } else {
                    // 放開開火鍵：如果是狙擊槍且蓄力足夠，則發射
                    if (player.classType === 'sniper' && player.chargeProgress >= 90) {
                        this.fireBullet(player, player.angle);
                    }
                    player.chargeProgress = 0;
                }

                // 處理大招觸發
                if (input.useSkill && player.skillCooldown === 0) {
                    this.castSpecialSkill(player);
                }
            }
        });

        // 2. 更新子彈
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const b = this.bullets[i];
            b.x += b.vx;
            b.y += b.vy;
            b.traveled += Math.sqrt(b.vx * b.vx + b.vy * b.vy);

            let hit = false;

            // 檢測是否超出射程
            if (b.traveled >= b.range) {
                hit = true;
            }

            // 檢測是否撞牆
            if (!hit && this.checkObstacleCollision(b.x, b.y, b.radius)) {
                hit = true;
            }

            // 檢測是否超出地圖邊界
            if (!hit && (b.x < 0 || b.x > WORLD_WIDTH || b.y < 0 || b.y > WORLD_HEIGHT)) {
                hit = true;
            }

            // 檢測是否擊中敵方玩家
            if (!hit) {
                for (const victim of this.players) {
                    if (victim.team !== b.team && !victim.isDead && !victim.isInvulnerable) {
                        const dx = victim.x - b.x;
                        const dy = victim.y - b.y;
                        const distSq = dx * dx + dy * dy;
                        // 玩家半徑 20，加上子彈半徑
                        if (distSq < (20 + b.radius) * (20 + b.radius)) {
                            this.damagePlayer(victim, b.damage, b.playerId);
                            hit = true;
                            break;
                        }
                    }
                }
            }

            if (hit) {
                // 子彈擊中或消失，引發油漆塗地
                this.paintSplat(b.x, b.y, b.paintRadius, b.team);
                this.bullets.splice(i, 1);
            }
        }

        // 3. 更新多重導彈 (步槍大招)
        for (let i = this.missiles.length - 1; i >= 0; i--) {
            const m = this.missiles[i];
            m.timer--;

            // 當導彈剛好剩下 30 幀 (0.5秒) 時，可以發送警告特效（這可由前端自行根據 timer 計算，後端主要處理落地）
            if (m.timer <= 0) {
                // 落地爆炸：對半徑 150 內的所有敵方玩家造成 80 點傷害
                this.players.forEach(enemy => {
                    if (enemy.team === m.team || enemy.isDead || enemy.isInvulnerable) return;
                    const distSq = (enemy.x - m.targetX) * (enemy.x - m.targetX) + (enemy.y - m.targetY) * (enemy.y - m.targetY);
                    if (distSq <= 150 * 150) {
                        this.damagePlayer(enemy, 80, m.playerId);
                    }
                });

                // 產生大範圍塗地
                this.paintSplat(m.targetX, m.targetY, 120, m.team);
                this.missiles.splice(i, 1);
            }
        }

        // 4. 廣播遊戲狀態給房間內所有玩家
        const state = {
            entities: this.players.map(p => ({
                id: p.id,
                name: p.name,
                classType: p.classType,
                team: p.team,
                x: p.x,
                y: p.y,
                vx: p.vx,
                vy: p.vy,
                angle: p.angle,
                hp: p.hp,
                isDead: p.isDead,
                specialState: {
                    sharkRideTimer: p.sharkRideTimer,
                    splashdownTimer: p.splashdownTimer,
                    skillCooldown: p.skillCooldown,
                    chargeProgress: p.chargeProgress
                }
            })),
            gameTime: this.gameTime,
            scores: this.scores
        };

        this.io.to(this.roomId).emit('game_state', state);
    }

    /**
     * 結束遊戲與計算勝負
     */
    endGame() {
        this.stop();

        this.calculateScores();

        // 判定勝負
        let winner = 'draw';
        const redVal = parseFloat(this.scores.red);
        const blueVal = parseFloat(this.scores.blue);
        if (redVal > blueVal) {
            winner = 'red';
        } else if (blueVal > redVal) {
            winner = 'blue';
        }

        // 廣播遊戲結束與戰績
        this.io.to(this.roomId).emit('game_over', {
            winner,
            scores: this.scores,
            stats: this.stats
        });

        // 觸發房間回呼
        if (this.onGameOver) {
            this.onGameOver();
        }
    }
}

module.exports = GameLoop;

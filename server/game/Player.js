/**
 * Player.js
 * 玩家類別，定義玩家屬性、狀態更新以及受傷重生邏輯。
 * 使用 ES6+ 語法與中文註解。
 */

// 職業常數設定，對齊前端的數值設計
const CLASS_PROFILES = {
    rifle: { 
        maxHp: 100, 
        speed: 4.2, 
        bulletDamage: 18, 
        bulletRange: 480, 
        shootCooldown: 5, 
        paintRadius: 16, 
        skillCd: 420, // 7 秒 (420 幀)
        desc: '步槍', 
        skillName: '多重導彈' 
    },
    tank: { 
        maxHp: 180, 
        speed: 3.0, 
        bulletDamage: 14, 
        bulletRange: 320, 
        shootCooldown: 8, 
        paintRadius: 20, 
        skillCd: 540, // 9 秒 (540 幀)
        desc: '坦克', 
        skillName: '鯊魚坐騎' 
    },
    sniper: { 
        maxHp: 70, 
        speed: 2.8, 
        bulletDamage: 65, 
        bulletRange: 900, 
        shootCooldown: 24, 
        paintRadius: 14, 
        skillCd: 480, // 8 秒 (480 幀)
        desc: '狙擊', 
        skillName: '貫穿極光' 
    },
    knife: { 
        maxHp: 90, 
        speed: 4.8, 
        bulletDamage: 40, 
        bulletRange: 110, 
        shootCooldown: 18, 
        paintRadius: 55, 
        skillCd: 360, // 6 秒 (360 幀)
        desc: '滾刷', 
        skillName: '凌空墜擊' 
    }
};

class Player {
    constructor(id, name, classType, team, x, y) {
        this.id = id;               // socket.id
        this.name = name;           // 玩家名稱
        this.classType = classType; // 職業類型 ('rifle', 'tank', 'sniper', 'knife')
        this.team = team;           // 隊伍 ('red' 或 'blue')
        
        // 根據職業載入數值
        const profile = CLASS_PROFILES[classType] || CLASS_PROFILES.rifle;
        this.maxHp = profile.maxHp;
        this.hp = profile.maxHp;
        this.speed = profile.speed;
        this.baseSpeed = profile.speed; // 備用基礎速度
        
        // 位置與移動
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        this.angle = 0;
        
        // 狀態標記
        this.isDead = false;
        this.respawnTimer = 0;      // 重生倒數 (幀數)
        this.skillCooldown = 0;     // 大招冷卻時間 (幀數)
        this.chargeProgress = 0;    // 狙擊槍蓄力進度 (0 ~ 100)
        this.shootTimer = 0;        // 普攻冷卻計時器
        
        // 特殊狀態計時器 (幀數)
        this.sharkRideTimer = 0;    // 坦克：鯊魚坐騎衝刺剩餘幀數
        this.sharkRideAngle = 0;    // 坦克：鯊魚衝刺時的固定角度
        this.splashdownTimer = 0;   // 滾刷：凌空墜擊剩餘幀數 (如上升與下墜合計 90 幀)
    }

    // 取得玩家當前是否無敵 (大招狀態中)
    get isInvulnerable() {
        // 鯊魚衝刺期間，或者凌空墜擊在空中時 (splashdownTimer > 15 幀，留下 15 幀落地後硬直可受傷)
        return this.sharkRideTimer > 0 || this.splashdownTimer > 15;
    }

    // 玩家受傷計算
    takeDamage(amount) {
        if (this.isDead || this.isInvulnerable) return false;
        
        this.hp = Math.max(0, this.hp - amount);
        if (this.hp <= 0) {
            this.isDead = true;
            this.respawnTimer = 180; // 3 秒 (180 幀)
            this.vx = 0;
            this.vy = 0;
            this.sharkRideTimer = 0;
            this.splashdownTimer = 0;
            this.chargeProgress = 0;
            return true; // 代表被擊倒了
        }
        return false; // 僅受傷，未陣亡
    }

    // 玩家重生
    respawn(spawnX, spawnY) {
        this.x = spawnX;
        this.y = spawnY;
        this.vx = 0;
        this.vy = 0;
        this.hp = this.maxHp;
        this.isDead = false;
        this.respawnTimer = 0;
        this.sharkRideTimer = 0;
        this.splashdownTimer = 0;
        this.chargeProgress = 0;
        this.shootTimer = 0;
    }

    // 重設大招冷卻
    useSkill() {
        const profile = CLASS_PROFILES[this.classType] || CLASS_PROFILES.rifle;
        this.skillCooldown = profile.skillCd;
    }

    // 每幀更新狀態
    update() {
        // 更新普攻冷卻
        if (this.shootTimer > 0) {
            this.shootTimer--;
        }

        // 更新死亡重生倒數
        if (this.isDead) {
            if (this.respawnTimer > 0) {
                this.respawnTimer--;
            }
            return; // 死亡狀態不更新大招冷卻與技能狀態
        }

        // 更新技能冷卻
        if (this.skillCooldown > 0) {
            this.skillCooldown--;
        }

        // 更新坦克大招狀態
        if (this.sharkRideTimer > 0) {
            this.sharkRideTimer--;
        }

        // 更新滾刷大招狀態
        if (this.splashdownTimer > 0) {
            this.splashdownTimer--;
        }
    }
}

module.exports = {
    Player,
    CLASS_PROFILES
};

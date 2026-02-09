const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DB ---
const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } }
else { saveDatabase(); }
function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }

let activeSockets = {}; 
let playerCounts = { lobby: 0, colorgame: 0, roulette: 0 };
let rouletteHistory = []; 

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// ==========================================
//  ROULETTE STATE MACHINE
// ==========================================
let rState = {
    phase: 'BETTING', 
    timeLeft: 20,
    bets: [] 
};

setInterval(() => {
    // PHASE: BETTING
    if(rState.phase === 'BETTING') {
        rState.timeLeft--;
        
        // SYNC TIMER TO ALL CLIENTS
        io.to('roulette').emit('roulette_state_update', {
            phase: 'BETTING',
            time: rState.timeLeft
        });

        // TIME UP -> START ROUND
        if(rState.timeLeft <= 0) {
            startRouletteRound();
        }
    }
}, 1000);

function startRouletteRound() {
    rState.phase = 'PROCESSING';
    
    // 1. LOCK (Immediate)
    io.to('roulette').emit('roulette_state_update', { phase: 'LOCKED', time: 0 });

    // 2. RESULT
    let resultNum = Math.floor(Math.random() * 37);
    rouletteHistory.unshift(resultNum);
    if(rouletteHistory.length > 23) rouletteHistory.pop();

    // 3. SPIN (Clients start 4s spin)
    io.to('roulette').emit('roulette_spin_start', resultNum);

    // 4. CALCULATE WINNINGS
    let roundWinners = [];
    rState.bets.forEach(bet => {
        if(bet.numbers.includes(resultNum)) {
            let count = bet.numbers.length;
            let payoutMult = (count===1)?36 : (count===2)?18 : (count===3)?12 : (count===4)?9 : (count===6)?6 : (count===12)?3 : 2;
            let winAmount = bet.amount * payoutMult;
            
            if(users[bet.username]) {
                users[bet.username].balance += winAmount;
                roundWinners.push({ 
                    socketId: bet.socketId, 
                    win: winAmount, 
                    bal: users[bet.username].balance 
                });
            }
        }
    });
    saveDatabase();

    // 5. ANIMATION TIMELINE (Server waits for Client visuals)
    // Spin (4s) + Hold (1.5s) + Reveal (1.5s) = 7s mark -> Send Payout Data
    
    setTimeout(() => {
        // Trigger Gather + Coin Animation
        roundWinners.forEach(w => {
            io.to(w.socketId).emit('roulette_win_data', { amount: w.win, balance: w.bal, number: resultNum });
        });
        io.to('roulette').emit('roulette_history', rouletteHistory); // Update history

        // 6. RESET (After Gather 2s + Coin 1.5s = 3.5s)
        setTimeout(() => {
            rState.phase = 'BETTING';
            rState.timeLeft = 20; 
            rState.bets = [];
            io.to('roulette').emit('roulette_reset'); // Clears table
        }, 4000); 

    }, 7500); 
}

// --- COLOR GAME LOOP (Simple) ---
let colorState = { status: 'BETTING', timeLeft: 20, bets: [] };
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            io.to('colorgame').emit('game_rolling');
            setTimeout(() => {
                io.to('colorgame').emit('game_result', result);
                colorState.bets.forEach(bet => {
                    let matches = result.filter(c => c === bet.color).length;
                    if(matches > 0 && users[bet.username]) {
                        let win = bet.amount * (matches + 1);
                        users[bet.username].balance += win;
                        io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
                    }
                });
                saveDatabase();
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20; colorState.bets = [];
                    io.to('colorgame').emit('timer_update', 20);
                    io.to('colorgame').emit('game_reset');
                }, 5000);
            }, 3000);
        } else { io.to('colorgame').emit('timer_update', colorState.timeLeft); }
    }
}, 1000);

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('login', (data) => {
        if(users[data.username] && users[data.username].password === data.password) {
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: users[data.username].balance });
            socket.emit('roulette_history', rouletteHistory);
            socket.emit('roulette_state_update', { phase: rState.phase, time: rState.timeLeft });
        } else { socket.emit('login_error', "Invalid Credentials"); }
    });

    socket.on('register', (data) => {
        if(!users[data.username]) {
            users[data.username] = { password: data.password, balance: 1000, history: [] };
            saveDatabase();
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: 1000 });
        } else { socket.emit('login_error', "Username taken"); }
    });

    socket.on('place_bet_roulette', (data) => {
        let u = activeSockets[socket.id];
        if(!u || rState.phase !== 'BETTING') return; 
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rState.bets.push({ username: u.username, numbers: data.numbers, amount: data.amount, socketId: socket.id });
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    socket.on('roulette_undo', () => {
        let u = activeSockets[socket.id];
        if(!u || rState.phase !== 'BETTING') return;
        let myBets = rState.bets.filter(b => b.socketId === socket.id);
        if(myBets.length > 0) {
            let lastBet = myBets[myBets.length - 1];
            users[u.username].balance += lastBet.amount;
            rState.bets.splice(rState.bets.lastIndexOf(lastBet), 1);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bet_undone');
        }
    });

    socket.on('roulette_clear', () => {
        let u = activeSockets[socket.id];
        if(!u || rState.phase !== 'BETTING') return;
        let userBets = rState.bets.filter(b => b.socketId === socket.id);
        if(userBets.length > 0) {
            let refund = userBets.reduce((a,b) => a + b.amount, 0);
            users[u.username].balance += refund;
            rState.bets = rState.bets.filter(b => b.socketId !== socket.id);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bets_cleared');
        }
    });

    socket.on('switch_room', (room) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, room);
    });

    socket.on('disconnect', () => {
        if(activeSockets[socket.id]) delete activeSockets[socket.id];
    });
});

function joinRoom(socket, username, room) {
    if(activeSockets[socket.id]) socket.leave(activeSockets[socket.id].room);
    activeSockets[socket.id] = { username: username, room: room };
    socket.join(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino Running on Port ${PORT}`));

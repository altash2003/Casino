const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } }

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }

// TRACKING
let activeSockets = {}; 
let chatHistory = { public: [], support: [] };

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// --- BROADCAST FUNCTIONS ---
function broadcastRoomList(room) {
    if(!room || room === 'lobby') return;
    let list = [];
    for(let id in activeSockets) {
        if(activeSockets[id].room === room) {
            list.push({ id: id, username: activeSockets[id].username });
        }
    }
    io.to(room).emit('room_users_update', list);
}

// --- GAME STATE ---
let colorState = { status: 'BETTING', timeLeft: 20, bets: [] };
let rouletteState = { status: 'BETTING', timeLeft: 40, bets: [] }; // Increased time for complex bets

// COLOR GAME LOOP
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 0) {
            colorState.status = 'ROLLING';
            io.to('colorgame').emit('game_rolling');
            const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            setTimeout(() => {
                io.to('colorgame').emit('game_result', result);
                processColorWinners(result);
                setTimeout(() => {
                    colorState.status = 'BETTING'; colorState.timeLeft = 20; colorState.bets = [];
                    io.to('colorgame').emit('game_reset');
                }, 5000);
            }, 3000);
        } else {
            io.to('colorgame').emit('timer_update', colorState.timeLeft);
        }
    }
}, 1000);

// ROULETTE LOOP
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        io.to('roulette').emit('roulette_timer', rouletteState.timeLeft);
        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'SPINNING';
            let resultNum = Math.floor(Math.random() * 37);
            io.to('roulette').emit('roulette_spin_start', resultNum);
            setTimeout(() => {
                io.to('roulette').emit('roulette_result_log', resultNum);
                processRouletteWinners(resultNum);
                setTimeout(() => {
                    rouletteState.status = 'BETTING'; rouletteState.timeLeft = 40; rouletteState.bets = [];
                    io.to('roulette').emit('roulette_new_round');
                }, 6000);
            }, 10000); 
        }
    }
}, 1000);

function processColorWinners(result) {
    colorState.bets.forEach(bet => {
        let matches = result.filter(c => c === bet.color).length;
        if(matches > 0) {
            let win = bet.amount * (matches + 1);
            if(users[bet.username]) {
                users[bet.username].balance += win;
                io.to(bet.socketId).emit('win_notification', { amount: win, game: "Color Game" });
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
}

function processRouletteWinners(winningNumber) {
    rouletteState.bets.forEach(bet => {
        if(bet.numbers.includes(winningNumber)) {
            let count = bet.numbers.length;
            // Payouts: 1->35:1, 2->17:1, 3->11:1, 4->8:1, 6->5:1, 12->2:1, 18->1:1
            let payoutMult = count === 1 ? 36 : count === 2 ? 18 : count === 3 ? 12 : count === 4 ? 9 : count === 6 ? 6 : count === 12 ? 3 : 2;
            let win = bet.amount * payoutMult;
            if(users[bet.username]) {
                users[bet.username].balance += win;
                io.to(bet.socketId).emit('roulette_win', { amount: win, number: winningNumber });
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
}

io.on('connection', (socket) => {
    // LOGIN / REGISTER
    socket.on('login', (data) => {
        if(users[data.username] && users[data.username].password === data.password) {
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: users[data.username].balance });
        } else { socket.emit('login_error', "Invalid Credentials"); }
    });
    socket.on('register', (data) => {
        const u = data.username; const p = data.password;
        if(!/^[a-zA-Z0-9]{5,12}$/.test(u)) return socket.emit('login_error', "User: 5-12 chars (Alphanumeric)");
        if(!p || p.length < 5 || p.length > 12) return socket.emit('login_error', "Pass: 5-12 chars");
        if(users[u]) return socket.emit('login_error', "Taken");
        users[u] = { password: p, balance: 1000 };
        saveDatabase();
        joinRoom(socket, u, 'lobby');
        socket.emit('login_success', { username: u, balance: 1000 });
    });

    socket.on('switch_room', (room) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, room);
    });

    // VOICE
    socket.on('voice_data', (blob) => {
        let u = activeSockets[socket.id];
        if(u && u.room !== 'lobby') socket.to(u.room).emit('voice_receive', { id: socket.id, audio: blob });
    });
    socket.on('voice_status', (isTalking) => {
        let u = activeSockets[socket.id];
        if(u && u.room !== 'lobby') io.to(u.room).emit('player_voice_update', { id: socket.id, talking: isTalking });
    });

    // CHAT (Public vs Support)
    socket.on('chat_msg', (data) => {
        let u = activeSockets[socket.id];
        if(u && data.msg) {
            let type = data.type || 'public'; // 'public' or 'support'
            let msgObj = { user: u.username, msg: data.msg, type: type };
            
            if(type === 'support') {
                // Send to user and Admins (Everyone receives support msgs in this demo for simplicity)
                io.emit('chat_broadcast', msgObj); 
            } else {
                // Send to room
                io.to(u.room).emit('chat_broadcast', msgObj);
            }
        }
    });

    // BETS
    socket.on('place_bet', (data) => {
        let u = activeSockets[socket.id];
        if(!u || colorState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            colorState.bets.push({ username: u.username, color: data.color, amount: data.amount, socketId: socket.id });
        }
    });
    socket.on('place_bet_roulette', (data) => {
        let u = activeSockets[socket.id];
        if(!u || rouletteState.status !== 'BETTING') return;
        if(users[u.username].balance >= data.amount) {
            users[u.username].balance -= data.amount;
            rouletteState.bets.push({ username: u.username, numbers: data.numbers, amount: data.amount, socketId: socket.id });
        }
    });
    socket.on('roulette_clear', () => {
        let u = activeSockets[socket.id];
        if(!u || rouletteState.status !== 'BETTING') return;
        let myBets = rouletteState.bets.filter(b => b.socketId === socket.id);
        if(myBets.length > 0) {
            users[u.username].balance += myBets.reduce((a,b)=>a+b.amount,0);
            rouletteState.bets = rouletteState.bets.filter(b => b.socketId !== socket.id);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bets_cleared');
        }
    });

    socket.on('disconnect', () => {
        let u = activeSockets[socket.id];
        if(u) {
            let r = u.room; delete activeSockets[socket.id];
            broadcastRoomList(r);
        }
    });
});

function joinRoom(socket, username, room) {
    let old = activeSockets[socket.id];
    if(old) { socket.leave(old.room); broadcastRoomList(old.room); }
    activeSockets[socket.id] = { username: username, room: room };
    socket.join(room);
    broadcastRoomList(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on ${PORT}`));

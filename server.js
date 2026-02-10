const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // Allow audio chunks
});

const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE)); } catch(e){ users = {}; } }

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }

// State Tracking
let activeSockets = {}; // { socketId: { username, room, isTalking } }
let chatHistory = { colorgame: [], roulette: [] };
let supportHistory = [];

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// --- BROADCAST HELPERS ---
function broadcastRoomList(room) {
    if(!room || room === 'lobby') return;
    let list = [];
    for(let id in activeSockets) {
        if(activeSockets[id].room === room) {
            list.push({ 
                id: id, 
                username: activeSockets[id].username,
                talking: activeSockets[id].isTalking || false
            });
        }
    }
    io.to(room).emit('room_users_update', list);
}

// --- GAME LOOPS ---
let colorState = { status: 'BETTING', timeLeft: 20, bets: [] };
let rouletteState = { status: 'BETTING', timeLeft: 30, bets: [] };

// Color Game Loop
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
                    io.to('colorgame').emit('timer_update', 20);
                }, 5000);
            }, 3000);
        } else {
            io.to('colorgame').emit('timer_update', colorState.timeLeft);
        }
    }
}, 1000);

// Roulette Loop
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
                    rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30; rouletteState.bets = [];
                    io.to('roulette').emit('roulette_new_round');
                }, 9000); 
            }, 9000); 
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
                io.to(bet.socketId).emit('win_notification', { game: 'COLOR GAME', amount: win });
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
}

function processRouletteWinners(winningNumber) {
    rouletteState.bets.forEach(bet => {
        if(bet.numbers.includes(winningNumber)) {
            // Standard Payouts: Straight 35:1, Split 17:1, Street 11:1, Corner 8:1, Line 5:1, Column/Doz 2:1, Even/Odd 1:1
            // My simplified multiplier logic based on count:
            let count = bet.numbers.length;
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
    
    // Auth
    socket.on('login', (data) => {
        if(users[data.username] && users[data.username].password === data.password) {
            joinRoom(socket, data.username, 'lobby');
            socket.emit('login_success', { username: data.username, balance: users[data.username].balance });
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

    socket.on('switch_room', (room) => {
        let u = activeSockets[socket.id];
        if(u) joinRoom(socket, u.username, room);
    });

    // Voice Chat Relay
    socket.on('voice_data', (blob) => {
        let u = activeSockets[socket.id];
        if(u && u.room !== 'lobby') {
            socket.to(u.room).emit('voice_receive', { id: socket.id, audio: blob });
        }
    });

    socket.on('voice_status', (isTalking) => {
        let u = activeSockets[socket.id];
        if(u && u.room !== 'lobby') {
            activeSockets[socket.id].isTalking = isTalking;
            // Broadcast visual update
            io.to(u.room).emit('player_voice_update', { id: socket.id, talking: isTalking });
        }
    });

    // Chat (Public vs Support)
    socket.on('chat_msg', (data) => {
        let u = activeSockets[socket.id];
        if(u && data.msg) {
            let msgObj = { type: 'public', user: u.username, msg: data.msg, room: data.room };
            if(chatHistory[data.room]) {
                chatHistory[data.room].push(msgObj);
                if(chatHistory[data.room].length > 20) chatHistory[data.room].shift();
            }
            io.to(data.room).emit('chat_broadcast', msgObj);
        }
    });

    socket.on('support_msg', (data) => {
        let u = activeSockets[socket.id];
        if(u && data.msg) {
            let msgObj = { type: 'support_sent', user: u.username, msg: data.msg }; // Send back to user
            socket.emit('chat_broadcast', msgObj); 
            // In a real app, you would emit to Admin room here
        }
    });

    // Betting
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
        let userBets = rouletteState.bets.filter(b => b.socketId === socket.id);
        if(userBets.length > 0) {
            let refund = userBets.reduce((a,b)=>a+b.amount,0);
            users[u.username].balance += refund;
            rouletteState.bets = rouletteState.bets.filter(b => b.socketId !== socket.id);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bets_cleared');
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        let u = activeSockets[socket.id];
        if(u) {
            let r = u.room;
            delete activeSockets[socket.id];
            
            // Update lobby counts
            let counts = { lobby:0, colorgame:0, roulette:0 };
            for(let i in activeSockets) counts[activeSockets[i].room]++;
            io.emit('lobby_counts', counts);
            
            broadcastRoomList(r);
        }
    });
});

function joinRoom(socket, username, room) {
    let old = activeSockets[socket.id] ? activeSockets[socket.id].room : null;
    if(old) {
        socket.leave(old);
        broadcastRoomList(old); 
    }

    activeSockets[socket.id] = { username: username, room: room, isTalking: false };
    socket.join(room);

    let counts = { lobby:0, colorgame:0, roulette:0 };
    for(let i in activeSockets) counts[activeSockets[i].room]++;
    io.emit('lobby_counts', counts);

    broadcastRoomList(room);
    if(chatHistory[room]) socket.emit('chat_history', chatHistory[room]);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on ${PORT}`));

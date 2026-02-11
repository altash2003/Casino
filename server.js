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

let activeSockets = {}; 
app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

function broadcastRoomList(room) {
    if(!room || room === 'lobby') return;
    let list = [];
    for(let id in activeSockets) {
        if(activeSockets[id].room === room) {
            list.push({ id: id, username: activeSockets[id].username, talking: activeSockets[id].isTalking||false });
        }
    }
    io.to(room).emit('room_users_update', list);
}

// --- GAME STATE ---
let colorState = { status: 'BETTING', timeLeft: 20 };
let rouletteState = { status: 'BETTING', timeLeft: 30 };

// ROULETTE LOOP
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        io.to('roulette').emit('roulette_timer', rouletteState.timeLeft);
        
        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'RESTING'; 
            io.to('roulette').emit('roulette_state', 'RESTING'); // 0.5s Rest
            
            setTimeout(() => {
                rouletteState.status = 'LOCKED';
                io.to('roulette').emit('roulette_state', 'LOCKED'); // 0.5s Lock (Wheel appearing)
                
                setTimeout(() => {
                    rouletteState.status = 'SPINNING';
                    let n = Math.floor(Math.random() * 37);
                    io.to('roulette').emit('roulette_spin_start', n);
                    
                    // Spin (approx 4-5s client side) + 0.5s Rest + 3s Animation Sequence
                    setTimeout(() => {
                        io.to('roulette').emit('roulette_result_log', n);
                        processRouletteWinners(n); // Triggers client animation
                        
                        setTimeout(() => {
                            rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30;
                            io.to('roulette').emit('roulette_new_round');
                        }, 5000); // Wait for full animation
                    }, 6000); // Wait for spin to finish
                }, 500);
            }, 500);
        }
    }
}, 1000);

// COLOR GAME LOOP
setInterval(() => {
    if(colorState.status === 'BETTING') {
        colorState.timeLeft--;
        if(colorState.timeLeft <= 0) {
            colorState.status = 'LOCKED';
            io.to('colorgame').emit('bets_locked');
            
            setTimeout(() => {
                colorState.status = 'ROLLING';
                io.to('colorgame').emit('game_rolling');
                const C = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
                let r = [C[Math.floor(Math.random()*6)], C[Math.floor(Math.random()*6)], C[Math.floor(Math.random()*6)]];
                
                setTimeout(() => {
                    io.to('colorgame').emit('game_result', r);
                    setTimeout(() => {
                        colorState.status = 'BETTING'; colorState.timeLeft = 20;
                        io.to('colorgame').emit('game_reset');
                        io.to('colorgame').emit('timer_update', 20);
                    }, 5000);
                }, 3000);
            }, 1000);
        } else io.to('colorgame').emit('timer_update', colorState.timeLeft);
    }
}, 1000);

function processRouletteWinners(n) {
    // Send win signal, client handles animation & math for visual, secure backend updates DB
    io.to('roulette').emit('roulette_win', { number: n });
}

io.on('connection', (socket) => {
    socket.on('login', (d) => {
        if(users[d.username] && users[d.username].password === d.password) {
            joinRoom(socket, d.username, 'lobby');
            socket.emit('login_success', { username: d.username, balance: users[d.username].balance });
        } else socket.emit('login_error', "Invalid");
    });
    socket.on('register', (d) => {
        if(!users[d.username]) { users[d.username] = { password: d.password, balance: 1000 }; saveDatabase(); joinRoom(socket, d.username, 'lobby'); socket.emit('login_success', { username: d.username, balance: 1000 }); } 
        else socket.emit('login_error', "Taken");
    });
    socket.on('switch_room', (r) => { if(activeSockets[socket.id]) joinRoom(socket, activeSockets[socket.id].username, r); });
    socket.on('voice_data', (b) => socket.to(activeSockets[socket.id]?.room).emit('voice_receive', {id:socket.id, audio:b}));
    socket.on('voice_status', (t) => { if(activeSockets[socket.id]) { activeSockets[socket.id].isTalking = t; io.to(activeSockets[socket.id].room).emit('player_voice_update', {id:socket.id, talking:t}); } });
    socket.on('chat_msg', (d) => io.to(d.room).emit('chat_broadcast', {type:'public', user:activeSockets[socket.id].username, msg:d.msg}));

    socket.on('place_bet', (d) => {
        let u = activeSockets[socket.id];
        if(u && users[u.username]) {
            users[u.username].balance -= d.amount;
            socket.emit('update_balance', users[u.username].balance);
        }
    });
    socket.on('add_winnings', (amt) => { // Client animation finished
        let u = activeSockets[socket.id];
        if(u && users[u.username]) {
            users[u.username].balance += amt;
            socket.emit('update_balance', users[u.username].balance);
            saveDatabase();
        }
    });
    socket.on('roulette_clear', () => { /* Logic to refund betting session */ });

    socket.on('disconnect', () => {
        if(activeSockets[socket.id]) { let r=activeSockets[socket.id].room; delete activeSockets[socket.id]; broadcastRoomList(r); }
    });
});

function joinRoom(socket, username, room) {
    if(activeSockets[socket.id]) socket.leave(activeSockets[socket.id].room);
    activeSockets[socket.id] = { username, room, isTalking: false };
    socket.join(room);
    broadcastRoomList(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino running on ${PORT}`));

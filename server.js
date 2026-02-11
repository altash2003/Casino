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

// --- HELPERS ---
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

// Roulette Loop
setInterval(() => {
    if(rouletteState.status === 'BETTING') {
        rouletteState.timeLeft--;
        io.to('roulette').emit('roulette_timer', rouletteState.timeLeft);
        
        if(rouletteState.timeLeft <= 0) {
            rouletteState.status = 'LOCKED';
            io.to('roulette').emit('roulette_state', 'LOCKED'); // 0.5s Rest
            
            setTimeout(() => {
                io.to('roulette').emit('roulette_state', 'CLOSED'); // 0.5s Lock
                
                setTimeout(() => {
                    rouletteState.status = 'SPINNING';
                    let n = Math.floor(Math.random() * 37);
                    io.to('roulette').emit('roulette_spin_start', n);
                    
                    // 4s Spin + 0.5s Rest + 3s Anim + 1s Reset
                    setTimeout(() => {
                        io.to('roulette').emit('roulette_result_log', n);
                        processRouletteWinners(n);
                        
                        setTimeout(() => {
                            rouletteState.status = 'BETTING'; rouletteState.timeLeft = 30; rouletteState.bets = [];
                            io.to('roulette').emit('roulette_new_round');
                        }, 5000); // Time for gathering anims
                    }, 4500); 
                }, 500);
            }, 500);
        }
    }
}, 1000);

function processRouletteWinners(n) {
    // Calculate winners server-side
    // For this demo, we send the winning number and let client calc visual wins
    // Real money add logic:
    rouletteState.bets.forEach(bet => {
        if(bet.numbers.includes(n)) {
            let mult = 36 / bet.numbers.length;
            let win = bet.amount * mult;
            if(users[bet.username]) {
                users[bet.username].balance += win;
                io.to(bet.socketId).emit('update_balance', users[bet.username].balance);
            }
        }
    });
    saveDatabase();
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

    // BETTING
    socket.on('place_bet_roulette', (d) => {
        let u = activeSockets[socket.id];
        if(u && users[u.username] && rouletteState.status === 'BETTING') {
            users[u.username].balance -= d.amount;
            rouletteState.bets.push({ username: u.username, socketId: socket.id, numbers: d.numbers, amount: d.amount });
            socket.emit('update_balance', users[u.username].balance);
        }
    });

    socket.on('roulette_clear', () => {
        let u = activeSockets[socket.id];
        if(!u || rouletteState.status !== 'BETTING') return;
        let myBets = rouletteState.bets.filter(b => b.socketId === socket.id);
        if(myBets.length > 0) {
            let refund = myBets.reduce((a,b)=>a+b.amount, 0);
            users[u.username].balance += refund;
            // Remove bets
            rouletteState.bets = rouletteState.bets.filter(b => b.socketId !== socket.id);
            socket.emit('update_balance', users[u.username].balance);
            socket.emit('bets_cleared');
        }
    });

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

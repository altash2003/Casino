const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// DATABASE
const DB_FILE = 'database.json';
let users = {};
if (fs.existsSync(DB_FILE)) { users = JSON.parse(fs.readFileSync(DB_FILE)); }

// GLOBAL DATA
let supportHistory = []; 
let globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }
function logHistory(username, message, balance) {
    if (!users[username].history) users[username].history = [];
    users[username].history.unshift(`[${new Date().toLocaleTimeString()}] ${message} | BAL: ${balance}`);
    if (users[username].history.length > 100) users[username].history.pop();
}

app.use(express.static(__dirname)); 
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });
app.get('/admin', (req, res) => { res.sendFile(__dirname + '/admin.html'); });

// GAME CONSTANTS
const COLORS = ['RED', 'GREEN', 'BLUE', 'YELLOW', 'PINK', 'WHITE'];
let gameState = 'BETTING'; 
let timeLeft = 20; 
let activePlayers = {}; 
let roundBets = []; 
let chatCooldowns = {};

// MUSIC STATE
let musicState = { playing: false, trackUrl: '', title: 'Waiting for DJ...', artist: '', timestamp: 0, lastUpdate: Date.now() };

// GAME LOOP
setInterval(() => {
    if (gameState === 'BETTING') {
        timeLeft--;
        if (timeLeft <= 3 && timeLeft > 0) { io.emit('countdown_beep', timeLeft); }
        
        if (timeLeft <= 0) {
            gameState = 'ROLLING';
            let result = [COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)], COLORS[Math.floor(Math.random()*6)]];
            io.emit('game_rolling'); 

            setTimeout(() => {
                io.emit('game_result', result); 
                processWinners(result);         
                
                roundBets = [];
                globalColorBets = { RED:0, GREEN:0, BLUE:0, PINK:0, WHITE:0, YELLOW:0 };
                
                setTimeout(() => { 
                    gameState = 'BETTING'; 
                    timeLeft = 20; 
                    io.emit('game_reset'); 
                    io.emit('update_global_bets', globalColorBets);
                    io.emit('clear_winners_panel'); 
                }, 5000); 
            }, 3000); 

        } else { io.emit('timer_update', timeLeft); }
    }
}, 1000);

function processWinners(diceResult) {
    let winnersList = []; 
    let userBets = {}; 

    roundBets.forEach(bet => {
        if(!userBets[bet.username]) userBets[bet.username] = { socketId: bet.socketId, bets: {} };
        if(!userBets[bet.username].bets[bet.color]) userBets[bet.username].bets[bet.color] = 0;
        userBets[bet.username].bets[bet.color] += bet.amount;
    });

    for (let [username, data] of Object.entries(userBets)) {
        let totalWin = 0;
        let winDetails = []; 

        for(let [color, amount] of Object.entries(data.bets)) {
            let matches = 0;
            diceResult.forEach(die => { if(die === color) matches++; });

            if (matches > 0) {
                let multiplier = matches + 1; 
                let winAmount = amount * multiplier;
                totalWin += winAmount;
                winDetails.push({ color: color, bet: amount, multiplier: multiplier, win: winAmount });
                
                if(users[username]) {
                    users[username].balance += winAmount;
                    logHistory(username, `WIN +${winAmount} (${color}: ${amount} x${multiplier})`, users[username].balance);
                }
            } else {
                if(users[username]) {
                    logHistory(username, `LOST -${amount} on ${color}`, users[username].balance);
                }
            }
        }

        if(totalWin > 0) {
            saveDatabase();
            io.to(data.socketId).emit('win_notification', { total: totalWin, details: winDetails });
            io.to(data.socketId).emit('update_balance', users[username].balance);
            winnersList.push({ username: username, amount: totalWin });
        }
    }

    if(winnersList.length > 0) {
        winnersList.sort((a,b) => b.amount - a.amount);
        io.emit('update_winners', winnersList);
    }
}

io.on('connection', (socket) => {
    let currentSeek = musicState.playing ? musicState.timestamp + (Date.now() - musicState.lastUpdate)/1000 : musicState.timestamp;
    socket.emit('music_sync', { playing: musicState.playing, seek: currentSeek, url: musicState.trackUrl, title: musicState.title, artist: musicState.artist });
    socket.emit('update_global_bets', globalColorBets);
    socket.emit('active_players_list', Object.values(activePlayers));

    // AUTH
    socket.on('register', (data) => {
        if(!data.username || !data.password) { socket.emit('login_error', "Missing fields"); return; }
        if (users[data.username]) { 
            socket.emit('login_error', "Username Taken!"); 
        } else {
            users[data.username] = { password: data.password, balance: 0, history: [] };
            saveDatabase();
            loginUser(socket, data.username);
        }
    });

    socket.on('login', (data) => {
        if(!data.username || !data.password) { socket.emit('login_error', "Missing fields"); return; }
        if (!users[data.username]) {
            socket.emit('login_error', "User Not Found");
        } else if (users[data.username].password !== data.password) {
            socket.emit('login_error', "Wrong Password");
        } else { 
            loginUser(socket, data.username); 
        }
    });

    function loginUser(sock, user) {
        sock.join('players');
        activePlayers[sock.id] = user;
        sock.emit('login_success', { username: user, balance: users[user].balance });
        io.emit('active_players_list', Object.values(activePlayers)); 
        io.emit('admin_user_list', activePlayers); 
    }

    // GAME ACTIONS
    socket.on('place_bet', (data) => {
        let username = activePlayers[socket.id];
        if (!username || gameState !== 'BETTING') return;
        let cost = parseInt(data.amount);
        
        // Server-side Double Check
        if (users[username].balance >= cost) {
            users[username].balance -= cost; 
            saveDatabase();
            // We do NOT emit update_balance here anymore to prevent jumping. 
            // The client already deducted it optimistically.
            // We only emit if there was an error.
            
            roundBets.push({ socketId: socket.id, username: username, color: data.color, amount: cost });
            globalColorBets[data.color] += cost;
            io.emit('update_global_bets', globalColorBets);
        } else { 
            socket.emit('bet_error', "INSUFFICIENT CREDITS"); 
            socket.emit('update_balance', users[username].balance); // Re-sync if failed
        }
    });

    socket.on('undo_bet', () => {
        let username = activePlayers[socket.id];
        if (!username || gameState !== 'BETTING') return;
        let betIndex = -1;
        for (let i = roundBets.length - 1; i >= 0; i--) { if (roundBets[i].username === username) { betIndex = i; break; } }
        
        if (betIndex !== -1) {
            let bet = roundBets[betIndex];
            users[username].balance += bet.amount; 
            globalColorBets[bet.color] -= bet.amount;
            if(globalColorBets[bet.color] < 0) globalColorBets[bet.color] = 0;
            
            roundBets.splice(betIndex, 1); 
            saveDatabase();
            
            socket.emit('update_balance', users[username].balance);
            socket.emit('bet_undone', { color: bet.color, amount: bet.amount }); 
            io.emit('update_global_bets', globalColorBets);
        }
    });

    socket.on('clear_bets', () => {
        let username = activePlayers[socket.id];
        if (!username || gameState !== 'BETTING') return;
        let totalRefund = 0;
        roundBets = roundBets.filter(bet => {
            if (bet.username === username) { 
                totalRefund += bet.amount; 
                globalColorBets[bet.color] -= bet.amount; 
                return false; 
            }
            return true;
        });
        for(let c in globalColorBets) if(globalColorBets[c] < 0) globalColorBets[c] = 0;
        if (totalRefund > 0) {
            users[username].balance += totalRefund;
            saveDatabase();
            socket.emit('update_balance', users[username].balance);
            socket.emit('bets_cleared'); 
            io.emit('update_global_bets', globalColorBets);
        }
    });

    // CHAT
    socket.on('chat_msg', (msg) => {
        let user = activePlayers[socket.id];
        if(!user) return;
        if(chatCooldowns[user] && Date.now() < chatCooldowns[user]) return; 
        chatCooldowns[user] = Date.now() + 3000; 
        io.emit('chat_broadcast', { user: user, msg: msg, type: 'public' });
    });

    socket.on('support_msg', (msg) => {
        let user = activePlayers[socket.id];
        if(!user) return;
        let ticket = { user: user, msg: msg, time: Date.now() };
        supportHistory.push(ticket); 
        io.emit('admin_support_receive', ticket); 
        socket.emit('chat_broadcast', { user: "You", msg: msg, type: 'support_sent' }); 
    });

    // ADMIN ACTIONS
    socket.on('admin_chat_public', (msg) => io.emit('chat_broadcast', { user: "ADMIN", msg: msg, type: 'public_admin' }));
    
    socket.on('admin_reply_support', (data) => {
        // 1. Send to Player
        for (let [id, name] of Object.entries(activePlayers)) {
            if (name === data.targetUser) io.to(id).emit('chat_broadcast', { user: "ADMIN", msg: data.msg, type: 'support_reply' });
        }
        // 2. Save Log with Specific Format
        let formattedMsg = `To ${data.targetUser}: ${data.msg}`;
        let replyLog = { user: "ADMIN", msg: formattedMsg, time: Date.now(), isReply: true };
        supportHistory.push(replyLog);
        
        // 3. Echo to Admin
        socket.emit('chat_broadcast', { user: "ADMIN", msg: formattedMsg, type: 'support_log_echo' });
    });

    socket.on('admin_announce', (msg) => io.emit('notification', { msg: msg, duration: 5000 })); 

    socket.on('admin_update_metadata', (data) => {
        if(data.title) musicState.title = data.title; 
        if(data.artist) musicState.artist = data.artist;
        io.emit('metadata_update', musicState);
    });
    socket.on('admin_change_track', (newUrl) => {
        musicState.trackUrl = newUrl; musicState.timestamp = 0; musicState.playing = true; musicState.lastUpdate = Date.now();
        io.emit('music_track_changed', { url: newUrl });
    });
    socket.on('admin_music_action', (data) => {
        musicState.playing = (data.action === 'play');
        musicState.timestamp = data.seek; musicState.lastUpdate = Date.now();
        io.emit('music_sync', { playing: musicState.playing, seek: data.seek, url: musicState.trackUrl, title: musicState.title, artist: musicState.artist });
    });

    socket.on('admin_add_credits', (data) => {
        if (users[data.username]) {
            users[data.username].balance += parseInt(data.amount);
            logHistory(data.username, `ADMIN ADDED +${data.amount}`, users[data.username].balance);
            saveDatabase();
            for (let [id, name] of Object.entries(activePlayers)) {
                if (name === data.username) {
                    io.to(id).emit('update_balance', users[data.username].balance);
                    io.to(id).emit('notification', { msg: `ADMIN ADDED ${data.amount} CREDITS!`, duration: 3000 });
                }
            }
            socket.emit('admin_log', `Success: Added ${data.amount} to ${data.username}`);
            socket.emit('admin_data_resp', { users: users, active: activePlayers, support: supportHistory });
        }
    });

    socket.on('admin_deduct_credits', (data) => {
        if (users[data.username]) {
            users[data.username].balance -= parseInt(data.amount);
            if(users[data.username].balance < 0) users[data.username].balance = 0;
            logHistory(data.username, `ADMIN DEDUCTED -${data.amount}`, users[data.username].balance);
            saveDatabase();
            for (let [id, name] of Object.entries(activePlayers)) {
                if (name === data.username) {
                    io.to(id).emit('update_balance', users[data.username].balance);
                    io.to(id).emit('notification', { msg: `WITHDRAWAL: -${data.amount} CREDITS`, duration: 3000 });
                }
            }
            socket.emit('admin_log', `Success: Deducted ${data.amount} from ${data.username}`);
            socket.emit('admin_data_resp', { users: users, active: activePlayers, support: supportHistory });
        }
    });

    socket.on('admin_add_all', (amount) => {
        let count = 0;
        let amt = parseInt(amount);
        for(let [id, name] of Object.entries(activePlayers)) {
            if(users[name]) {
                users[name].balance += amt;
                logHistory(name, `ADMIN GIFT +${amt}`, users[name].balance);
                io.to(id).emit('update_balance', users[name].balance);
                io.to(id).emit('notification', { msg: `GIFT! +${amt} CREDITS`, duration: 3000 });
                count++;
            }
        }
        saveDatabase();
        socket.emit('admin_log', `Added ${amt} to ${count} active players.`);
        socket.emit('admin_data_resp', { users: users, active: activePlayers, support: supportHistory });
    });

    socket.on('admin_req_data', () => { 
        socket.emit('admin_data_resp', { users: users, active: activePlayers, support: supportHistory }); 
    });
    socket.on('disconnect', () => { 
        delete activePlayers[socket.id]; 
        io.emit('active_players_list', Object.values(activePlayers));
        io.emit('admin_user_list', activePlayers); 
    });
});

server.listen(process.env.PORT || 3000, () => { console.log('Server running'); });

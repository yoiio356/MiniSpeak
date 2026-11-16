const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const htmlPage = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>MiniSpeak — Голосовой чат</title>
    <style>
        body { font-family: sans-serif; background: #1e1f22; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .box { background: #2b2d31; padding: 25px; border-radius: 10px; width: 320px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
        input, button { width: 100%; padding: 10px; margin: 8px 0; border-radius: 5px; border: none; box-sizing: border-box; font-size: 14px; }
        input { background: #1e1f22; color: #fff; }
        button { background: #5865f2; color: #fff; cursor: pointer; font-weight: bold; }
        button:hover { background: #4752c4; }
        button.mute { background: #da373c; }
        ul { list-style: none; padding: 0; margin-top: 15px; }
        li { background: #313338; padding: 8px 12px; margin-bottom: 5px; border-radius: 4px; display: flex; align-items: center; border: 2px solid transparent; transition: border-color 0.15s; }
        li::before { content: '🟢'; margin-right: 10px; font-size: 10px; }
        li.speaking { border-color: #23a55a; }
        .hidden { display: none; }
    </style>
</head>
<body>

<div class="box" id="login-screen">
    <h3 style="margin-top:0">MiniSpeak</h3>
    <input type="text" id="username" placeholder="Ваш никнейм" required>
    <input type="text" id="room" placeholder="Название комнаты (напр. squad)" required>
    <button onclick="joinRoom()">Подключиться</button>
</div>

<div class="box hidden" id="call-screen">
    <h3 id="room-title" style="margin-top:0">Комната</h3>
    <ul id="users-list"></ul>
    <button id="mute-btn" onclick="toggleMute()">Выключить микрофон</button>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
    const socket = io();
    let localStream;
    const peers = {};
    let isMuted = false;

    const rtcConfig = {
        iceServers: [
            { urls: 'stun:://google.com' },
            { urls: 'stun:://google.com' }
        ]
    };

    async function joinRoom() {
        const username = document.getElementById('username').value.trim();
        const room = document.getElementById('room').value.trim().toLowerCase();
        if (!username || !room) return alert('Введите ник и комнату!');

        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (err) {
            return alert('Нет доступа к микрофону! Проверьте разрешения браузера.');
        }

        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('call-screen').classList.remove('hidden');
        document.getElementById('room-title').innerText = 'Комната: ' + room;
        addUserToList('me', username + ' (Вы)');
        detectSpeaking(localStream, 'me');

        socket.emit('join-room', room, username);

        socket.on('existing-users', (users) => {
            users.forEach(user => {
                addUserToList(user.id, user.username);
            });
        });

        socket.on('user-connected', async ({ id, username: remoteName }) => {
            addUserToList(id, remoteName);
            const peer = createPeer(id, true);
            peers[id] = peer;
        });

        socket.on('signal', async ({ from, username: remoteName, signal }) => {
            if (!peers[from]) {
                addUserToList(from, remoteName);
                peers[from] = createPeer(from, false);
            }
            const peer = peers[from];

            if (signal.sdp) {
                await peer.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                if (signal.sdp.type === 'offer') {
                    const answer = await peer.createAnswer();
                    await peer.setLocalDescription(answer);
                    socket.emit('signal', { to: from, signal: { sdp: peer.localDescription } });
                }
            } else if (signal.candidate) {
                await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
            }
        });

        socket.on('user-disconnected', (id) => {
            if (peers[id]) peers[id].close();
            delete peers[id];
            const el = document.getElementById('user-' + id);
            if (el) el.remove();
            const audio = document.getElementById('audio-' + id);
            if (audio) audio.remove();
        });
    }

    function createPeer(targetId, isInitiator) {
        const peer = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

        peer.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit('signal', { to: targetId, signal: { candidate: e.candidate } });
            }
        };

        peer.ontrack = (e) => {
            const remoteStream = e.streams[0];
            let audio = document.getElementById('audio-' + targetId);
            if (!audio) {
                audio = document.createElement('audio');
                audio.id = 'audio-' + targetId;
                audio.autoplay = true;
                document.body.appendChild(audio);
            }
            audio.srcObject = remoteStream;
            detectSpeaking(remoteStream, targetId);
        };

        if (isInitiator) {
            peer.onnegotiationneeded = async () => {
                const offer = await peer.createOffer();
                await peer.setLocalDescription(offer);
                socket.emit('signal', { to: targetId, signal: { sdp: peer.localDescription } });
            };
        }

        return peer;
    }

    function detectSpeaking(stream, userId) {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);

            setInterval(() => {
                analyser.getByteFrequencyData(data);
                const volume = data.reduce((a, b) => a + b) / data.length;
                const el = document.getElementById('user-' + userId);
                if (el) {
                    if (volume > 15 && !(userId === 'me' && isMuted)) {
                        el.classList.add('speaking');
                    } else {
                        el.classList.remove('speaking');
                    }
                }
            }, 100);
        } catch (e) {}
    }

    function toggleMute() {
        isMuted = !isMuted;
        localStream.getAudioTracks()[0].enabled = !isMuted;
        const btn = document.getElementById('mute-btn');
        btn.innerText = isMuted ? 'Включить микрофон' : 'Выключить микрофон';
        btn.classList.toggle('mute', isMuted);
    }

    function addUserToList(id, name) {
        if (document.getElementById('user-' + id)) return;
        const li = document.createElement('li');
        li.id = 'user-' + id;
        li.innerText = name;
        document.getElementById('users-list').appendChild(li);
    }
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(htmlPage);
});

const rooms = {};

io.on('connection', (socket) => {
    socket.on('join-room', (roomId, username) => {
        socket.join(roomId);
        if (!rooms[roomId]) rooms[roomId] = [];

        socket.emit('existing-users', rooms[roomId]);

        rooms[roomId].push({ id: socket.id, username });
        socket.to(roomId).emit('user-connected', { id: socket.id, username });

        socket.on('signal', (data) => {
            io.to(data.to).emit('signal', {
                from: socket.id,
                username: username,
                signal: data.signal
            });
        });

        socket.on('disconnect', () => {
            if (rooms[roomId]) {
                rooms[roomId] = rooms[roomId].filter(u => u.id !== socket.id);
                if (rooms[roomId].length === 0) delete rooms[roomId];
            }
            socket.to(roomId).emit('user-disconnected', socket.id);
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('MiniSpeak запущен на порту ' + PORT);
});

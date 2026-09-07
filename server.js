const { registerUser, loginUser, updateUserScore, getUsers, recordWin } = require('./users');
const path = require('path');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(__dirname));
const rooms = {};

const suits = ['♠', '♥', '♦', '♣'];
const values = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankValue = (v) => values.indexOf(v);

const TURN_TIMER = 40000;
const BOT_DELAY = 1500;

const loginAttempts = new Map();
function isRateLimited(ip) {
    const now = Date.now();
    const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < 60000);
    attempts.push(now);
    loginAttempts.set(ip, attempts);
    return attempts.length > 15;
}

function createDeck() {
    const deck = [];
    for (const suit of suits) {
        for (const value of values) {
            deck.push({ suit, value });
        }
    }
    return shuffle(deck);
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getPublicPlayers(room) {
    return room.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.cards.length,
        hasHip: p.hasHip || false,
        isOut: p.isOut || false,
        isCreator: p.id === room.creatorId,
        isBot: p.isBot || false,
        score: room.scores[p.id] || 0
    }));
}

function getActivePlayers(room) {
    return room.players.filter((p) => !p.isOut);
}

function findNextActivePlayer(room, fromIndex) {
    let next = (fromIndex + 1) % room.players.length;
    let count = 0;
    while (room.players[next].isOut && count < room.players.length) {
        next = (next + 1) % room.players.length;
        count++;
    }
    return next;
}

// Проверка: может ли карта beatCard побить карту pendingCard
function canBeatCard(beatCard, pendingCard, trumpSuit) {
    // Козырь бьёт всё, кроме козыря (тогда только старший козырь)
    if (beatCard.suit === trumpSuit && pendingCard.suit !== trumpSuit) return true;
    if (beatCard.suit === trumpSuit && pendingCard.suit === trumpSuit) {
        return rankValue(beatCard.value) > rankValue(pendingCard.value);
    }
    // Обычная карта бьёт только ту же масть и должна быть старше
    if (beatCard.suit === pendingCard.suit) {
        return rankValue(beatCard.value) > rankValue(pendingCard.value);
    }
    return false;
}

function awardBankAndFinish(room, loser, results, correctGuesses) {
    let winnerName = null;

    if (room.hipOrder.length > 0) {
        winnerName = room.hipOrder[0];
        const winnerPlayer = room.players.find((p) => p.name === winnerName);
        if (winnerPlayer) {
            const bankWon = room.bank;
            room.scores[winnerPlayer.id] = (room.scores[winnerPlayer.id] || 0) + room.bank;
            if (!winnerPlayer.isBot) {
                updateUserScore(winnerPlayer.name, room.scores[winnerPlayer.id]);
                io.to(winnerPlayer.id).emit('roundWon', { bank: bankWon });
                const vsBot = room.players.some((p) => p.isBot);
                const unlocked = recordWin(winnerPlayer.name, { vsBot });
                if (unlocked.length > 0) {
                    io.to(winnerPlayer.id).emit('achievementsUnlocked', unlocked);
                }
            }
            room.bank = 0;
        }
    }

    for (const player of room.players) {
        if (!player.isBot) {
            updateUserScore(player.name, room.scores[player.id] || 0);
        }
    }

    io.to(room.roomId).emit('guessResults', {
        loserName: loser.name,
        results,
        correctGuesses,
        scores: room.scores,
        players: getPublicPlayers(room)
    });

    room.guessPhase = null;
}

function checkGameEnd(room) {
    const activePlayers = getActivePlayers(room);
    if (activePlayers.length === 1) {
        const loser = activePlayers[0];
        const winners = room.players.filter((p) => p.hasHip);
        room.guessPhase = {
            loserId: loser.id,
            winners: winners.map((w) => ({ id: w.id, name: w.name }))
        };
        io.to(room.roomId).emit('gameOver', {
            loser: loser.name,
            players: getPublicPlayers(room)
        });
        if (!loser.isBot) {
            io.to(loser.id).emit('guessPhase', {
                winners: room.guessPhase.winners
            });
        } else {
            awardBankAndFinish(room, loser, [], 0);
        }
        return true;
    }
    return false;
}

function startTurnTimer(room) {
    clearTimeout(room.turnTimer);
    room.turnTimer = setTimeout(() => {
        const playerIndex = room.currentTurn;
        const player = room.players[playerIndex];
        if (player && !player.isOut && !room.pendingResponse && room.gameStarted && !room.guessPhase) {
            if (player.cards.length > 0) {
                const cardIndex = Math.floor(Math.random() * player.cards.length);
                handlePlayCard(room, player.id, cardIndex);
            }
        }
    }, TURN_TIMER);
}

function handlePlayCard(room, playerId, cardIndex) {
    const playerIndex = room.players.findIndex((p) => p.id === playerId);
    if (playerIndex !== room.currentTurn) return;
    const player = room.players[playerIndex];
    if (player.isOut || room.pendingResponse || room.guessPhase) return;
    const card = player.cards[cardIndex];
    if (!card) return;

    player.cards.splice(cardIndex, 1);

    if (player.cards.length < 3 && room.deck.length > 0) {
        player.cards.push(room.deck.pop());
    }

    room.lastPlayed = { card, playerName: player.name };

    let nextPlayerIndex = findNextActivePlayer(room, playerIndex);
    if (nextPlayerIndex === playerIndex) {
        checkGameEnd(room);
        return;
    }

    room.pendingResponse = {
        fromPlayerId: player.id,
        toPlayerId: room.players[nextPlayerIndex].id,
        card: card
    };

    room.currentTurn = nextPlayerIndex;
    startTurnTimer(room);

    io.to(room.roomId).emit('cardPlayed', {
        card,
        playerName: player.name,
        currentTurn: room.currentTurn,
        deckCount: room.deck.length,
        players: getPublicPlayers(room)
    });

    io.to(playerId).emit('yourCards', player.cards);

    const respondingPlayer = room.players[nextPlayerIndex];

    if (respondingPlayer.isBot) {
        setTimeout(() => {
            botRespond(room, respondingPlayer.id);
        }, BOT_DELAY);
    } else {
        io.to(respondingPlayer.id).emit('pendingResponse', {
            card: card,
            players: getPublicPlayers(room)
        });
        io.to(respondingPlayer.id).emit('yourCards', respondingPlayer.cards);
    }
}

function botChooseBeatOptions(bot, pendingCard, trumpSuit) {
    return bot.cards
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => canBeatCard(c, pendingCard, trumpSuit));
}

function botRespond(room, botId) {
    if (!room.pendingResponse) return;
    if (room.pendingResponse.toPlayerId !== botId) return;

    const bot = room.players.find((p) => p.id === botId);
    if (!bot || bot.isOut) return;

    const pendingCard = room.pendingResponse.card;
    const trumpSuit = room.trump.suit;
    const options = botChooseBeatOptions(bot, pendingCard, trumpSuit);

    if (options.length === 0) {
        handleRespond(room, botId, { action: 'take' });
        return;
    }

    // Пытаемся побить той же мастью минимальной СТАРШЕЙ картой
    const sameSuit = options
        .filter(({ c }) => c.suit === pendingCard.suit && c.suit !== trumpSuit)
        .sort((a, b) => rankValue(a.c.value) - rankValue(b.c.value));

    if (sameSuit.length > 0) {
        handleRespond(room, botId, { action: 'beat', cardIndex: sameSuit[0].i });
        return;
    }

    // Если нечем бить той же мастью, пробуем козырь (если pendingCard не козырь)
    if (pendingCard.suit !== trumpSuit) {
        const trumpOptions = options
            .filter(({ c }) => c.suit === trumpSuit)
            .sort((a, b) => rankValue(a.c.value) - rankValue(b.c.value));
        
        if (trumpOptions.length > 0) {
            handleRespond(room, botId, { action: 'beat', cardIndex: trumpOptions[0].i });
            return;
        }
    }

    // Нечем бить — забираем
    handleRespond(room, botId, { action: 'take' });
}

function handleRespond(room, playerId, data) {
    if (!room.pendingResponse) return;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.isOut) return;
    if (room.pendingResponse.toPlayerId !== player.id) return;

    const { action, cardIndex } = data;
    const pendingCard = room.pendingResponse.card;

    if (action === 'beat') {
        if (cardIndex === undefined || cardIndex === null) return;
        const beatCard = player.cards[cardIndex];
        if (!beatCard) return;
        const trumpSuit = room.trump.suit;
        if (!canBeatCard(beatCard, pendingCard, trumpSuit)) return;

        player.cards.splice(cardIndex, 1);

        if (player.cards.length < 3 && room.deck.length > 0) {
            player.cards.push(room.deck.pop());
        }

        room.lastPlayed = null;
        io.to(room.roomId).emit('cardBeaten', {
            beatenCard: pendingCard,
            beatCard: beatCard,
            playerName: player.name,
            currentTurn: room.currentTurn,
            deckCount: room.deck.length,
            players: getPublicPlayers(room)
        });

        room.pendingResponse = null;
        startTurnTimer(room);

        io.to(room.roomId).emit('turnUpdate', {
            currentTurn: room.currentTurn,
            players: getPublicPlayers(room),
            deckCount: room.deck.length
        });

        io.to(playerId).emit('yourCards', player.cards);

        if (player.isBot) {
            setTimeout(() => {
                botCheckHip(room, player.id);
            }, BOT_DELAY);
        }

        checkGameEnd(room);
    } else if (action === 'take') {
        player.cards.push(pendingCard);

        io.to(room.roomId).emit('cardTaken', {
            takenCard: pendingCard,
            playerName: player.name,
            currentTurn: room.currentTurn,
            deckCount: room.deck.length,
            players: getPublicPlayers(room)
        });

        room.pendingResponse = null;

        let nextPlayerIndex = findNextActivePlayer(room, room.players.findIndex((p) => p.id === player.id));
        room.currentTurn = nextPlayerIndex;
        startTurnTimer(room);

        io.to(room.roomId).emit('turnUpdate', {
            currentTurn: room.currentTurn,
            players: getPublicPlayers(room),
            deckCount: room.deck.length
        });

        io.to(playerId).emit('yourCards', player.cards);

        checkGameEnd(room);
    }
}

function botCheckHip(room, botId) {
    const bot = room.players.find((p) => p.id === botId);
    if (!bot || bot.isOut || room.guessPhase) return;

    if (bot.cards.length === 3 && bot.cards.every((c) => c.suit === bot.cards[0].suit)) {
        bot.hasHip = true;
        bot.isOut = true;
        room.hipOrder.push(bot.name);

        if (room.pendingResponse && room.pendingResponse.toPlayerId === bot.id) {
            room.pendingResponse = null;
            let next = findNextActivePlayer(room, room.players.findIndex((p) => p.id === bot.id));
            room.currentTurn = next;
            startTurnTimer(room);
        }

        io.to(room.roomId).emit('hipCalled', {
            playerName: bot.name,
            players: getPublicPlayers(room),
            hipOrder: room.hipOrder,
            currentTurn: room.currentTurn
        });

        if (!checkGameEnd(room)) {
            io.to(room.roomId).emit('turnUpdate', {
                currentTurn: room.currentTurn,
                players: getPublicPlayers(room),
                deckCount: room.deck.length
            });
        }
    } else {
        setTimeout(() => {
            botPlay(room, botId);
        }, BOT_DELAY);
    }
}

function botPlay(room, botId) {
    if (room.guessPhase) return;
    const bot = room.players.find((p) => p.id === botId);
    if (!bot || bot.isOut) return;

    const botIndex = room.players.findIndex((p) => p.id === botId);
    if (botIndex !== room.currentTurn) return;
    if (room.pendingResponse) return;
    if (bot.cards.length === 0) return;

    const trumpSuit = room.trump.suit;

    const suitCounts = {};
    bot.cards.forEach((c) => (suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1));
    const almostHipSuit = Object.entries(suitCounts).find(([s, n]) => n === 2 && s !== trumpSuit);

    let cardIndex;
    if (almostHipSuit) {
        cardIndex = bot.cards.findIndex((c) => c.suit !== almostHipSuit[0]);
        if (cardIndex === -1) cardIndex = 0;
    } else {
        const nonTrump = bot.cards.map((c, i) => ({ c, i })).filter((o) => o.c.suit !== trumpSuit);
        const pool = nonTrump.length > 0 ? nonTrump : bot.cards.map((c, i) => ({ c, i }));
        cardIndex = pool.sort((a, b) => rankValue(a.c.value) - rankValue(b.c.value))[0].i;
    }

    handlePlayCard(room, botId, cardIndex);
}

function resetGame(room) {
    clearTimeout(room.turnTimer);
    room.gameStarted = true;
    room.deck = createDeck();
    room.trump = room.deck[room.deck.length - 1];
    room.hipOrder = [];
    room.guessPhase = null;
    room.pendingResponse = null;
    room.readyForRestart = [];

    for (const player of room.players) {
        player.cards = [];
        player.hasHip = false;
        player.isOut = false;
        for (let i = 0; i < 3; i++) {
            player.cards.push(room.deck.pop());
        }
    }

    room.currentTurn = 0;
    startTurnTimer(room);

    io.to(room.roomId).emit('gameStarted', {
        trump: room.trump,
        currentTurn: room.currentTurn,
        players: getPublicPlayers(room),
        deckCount: room.deck.length,
        bank: room.bank
    });

    for (const player of room.players) {
        if (!player.isBot) {
            io.to(player.id).emit('yourCards', player.cards);
        }
    }

    const firstPlayer = room.players[room.currentTurn];
    if (firstPlayer && firstPlayer.isBot) {
        setTimeout(() => {
            botPlay(room, firstPlayer.id);
        }, BOT_DELAY);
    }
}

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    socket.on('register', async (data, callback) => {
        try {
            if (isRateLimited(socket.handshake.address)) {
                return callback({ error: 'Слишком много попыток, подождите минуту' });
            }
            const { username, password } = data || {};
            if (!username || !password) {
                return callback({ error: 'Заполните все поля' });
            }
            const result = await registerUser(username, password);
            if (result.error) {
                callback({ error: result.error });
            } else {
                socket.userProfile = { username, score: result.score, achievements: result.achievements || [] };
                callback(result);
            }
        } catch (e) {
            console.error('Ошибка регистрации:', e);
            callback({ error: 'Внутренняя ошибка сервера' });
        }
    });

    socket.on('login', async (data, callback) => {
        try {
            if (isRateLimited(socket.handshake.address)) {
                return callback({ error: 'Слишком много попыток, подождите минуту' });
            }
            const { username, password } = data || {};
            if (!username || !password) {
                return callback({ error: 'Заполните все поля' });
            }
            const result = await loginUser(username, password);
            if (result.error) {
                callback({ error: result.error });
            } else {
                socket.userProfile = { username, score: result.score, achievements: result.achievements || [] };
                callback(result);
            }
        } catch (e) {
            console.error('Ошибка входа:', e);
            callback({ error: 'Внутренняя ошибка сервера' });
        }
    });

    socket.on('getRating', (callback) => {
        const users = getUsers();
        const rating = Object.entries(users)
            .map(([username, data]) => ({ username, score: data.score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
        callback(rating);
    });

    socket.on('createRoom', (playerName, callback) => {
        const profile = socket.userProfile;
        if (!profile) {
            callback({ error: 'Необходимо войти в профиль' });
            return;
        }
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        rooms[roomId] = {
            roomId: roomId,
            creatorId: socket.id,
            players: [{ id: socket.id, name: profile.username, cards: [], hasHip: false, isOut: false, profile: profile, isBot: false }],
            deck: [],
            trump: null,
            currentTurn: 0,
            gameStarted: false,
            lastPlayed: null,
            hipOrder: [],
            scores: {},
            stakes: {},
            bank: 0,
            pendingResponse: null,
            guessPhase: null,
            readyForRestart: [],
            turnTimer: null,
            botCounter: 0
        };
        rooms[roomId].scores[socket.id] = profile.score;
        rooms[roomId].stakes[socket.id] = 10;
        socket.join(roomId);
        socket.roomId = roomId;
        callback({ roomId, players: getPublicPlayers(rooms[roomId]) });
    });

    socket.on('joinRoom', (data, callback) => {
        const { roomId } = data;
        const profile = socket.userProfile;
        if (!profile) {
            callback({ error: 'Необходимо войти в профиль' });
            return;
        }
        const room = rooms[roomId];

        if (!room) {
            callback({ error: 'Комната не найдена' });
            return;
        }

        if (room.players.length >= 6) {
            callback({ error: 'Комната заполнена' });
            return;
        }

        if (room.gameStarted) {
            callback({ error: 'Игра уже началась' });
            return;
        }

        room.players.push({ id: socket.id, name: profile.username, cards: [], hasHip: false, isOut: false, profile: profile, isBot: false });
        room.scores[socket.id] = profile.score;
        room.stakes[socket.id] = 10;
        socket.join(roomId);
        socket.roomId = roomId;

        io.to(roomId).emit('updatePlayers', getPublicPlayers(room));
        callback({ roomId, players: getPublicPlayers(room) });
    });

    socket.on('setStake', (stake) => {
        const room = rooms[socket.roomId];
        if (!room || room.gameStarted) return;
        if (stake < 10) return;
        if (room.scores[socket.id] < stake) return;
        room.stakes[socket.id] = stake;
        io.to(room.roomId).emit('updatePlayers', getPublicPlayers(room));
    });

    socket.on('addBot', () => {
        const room = rooms[socket.roomId];
        if (!room || room.gameStarted) return;
        if (room.players.length >= 6) return;

        room.botCounter++;
        const botId = `bot_${Date.now()}_${room.botCounter}`;
        const botName = `Бот ${room.botCounter}`;

        room.players.push({
            id: botId,
            name: botName,
            cards: [],
            hasHip: false,
            isOut: false,
            isBot: true,
            profile: { username: botName, score: 10000 }
        });
        room.scores[botId] = 10000;
        room.stakes[botId] = 10;

        io.to(room.roomId).emit('updatePlayers', getPublicPlayers(room));
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 2) return;
        if (socket.id !== room.creatorId) return;
        if (room.gameStarted) return;

        for (const player of room.players) {
            const stake = room.stakes[player.id] || 10;
            room.scores[player.id] = (room.scores[player.id] || 0) - stake;
            if (!player.isBot) {
                updateUserScore(player.name, room.scores[player.id]);
            }
        }
        room.bank = Object.values(room.stakes).reduce((sum, s) => sum + s, 0);

        resetGame(room);
    });

    socket.on('playCard', (cardIndex) => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameStarted || room.guessPhase) return;
        const playerIndex = room.players.findIndex((p) => p.id === socket.id);
        if (playerIndex !== room.currentTurn) return;
        handlePlayCard(room, socket.id, cardIndex);
    });

    socket.on('respondToCard', (data) => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameStarted || room.guessPhase) return;
        handleRespond(room, socket.id, data);
    });

    socket.on('callHip', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameStarted || room.guessPhase) return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || player.isOut) return;

        if (player.cards.length === 3 && player.cards.every((c) => c.suit === player.cards[0].suit)) {
            player.hasHip = true;
            player.isOut = true;
            room.hipOrder.push(player.name);

            if (room.pendingResponse && room.pendingResponse.toPlayerId === player.id) {
                room.pendingResponse = null;
                let next = findNextActivePlayer(room, room.players.findIndex((p) => p.id === player.id));
                room.currentTurn = next;
                startTurnTimer(room);
            }

            io.to(room.roomId).emit('hipCalled', {
                playerName: player.name,
                players: getPublicPlayers(room),
                hipOrder: room.hipOrder,
                currentTurn: room.currentTurn
            });

            if (!checkGameEnd(room)) {
                io.to(room.roomId).emit('turnUpdate', {
                    currentTurn: room.currentTurn,
                    players: getPublicPlayers(room),
                    deckCount: room.deck.length
                });
            }
        }
    });

    socket.on('submitGuess', (guesses) => {
        const room = rooms[socket.roomId];
        if (!room || !room.guessPhase) return;

        const loser = room.players.find((p) => p.id === socket.id);
        if (!loser || loser.id !== room.guessPhase.loserId) return;

        let correctGuesses = 0;
        const results = [];

        for (const guess of guesses) {
            const winner = room.players.find((p) => p.id === guess.playerId);
            if (winner && winner.hasHip) {
                const actualSuit = winner.cards[0].suit;
                const isCorrect = guess.suit === actualSuit;
                if (isCorrect) {
                    correctGuesses++;
                    room.scores[loser.id] = (room.scores[loser.id] || 0) + 2;
                    room.scores[winner.id] = (room.scores[winner.id] || 0) - 1;
                }
                results.push({
                    winnerName: winner.name,
                    guessedSuit: guess.suit,
                    actualSuit: actualSuit,
                    isCorrect: isCorrect
                });
            }
        }

        awardBankAndFinish(room, loser, results, correctGuesses);
    });

    socket.on('readyForRestart', () => {
        const room = rooms[socket.roomId];
        if (!room || !room.gameStarted) return;

        if (!room.readyForRestart.includes(socket.id)) {
            room.readyForRestart.push(socket.id);
        }

        io.to(room.roomId).emit('restartStatus', {
            readyCount: room.readyForRestart.length,
            totalPlayers: room.players.length,
            players: getPublicPlayers(room)
        });

        if (room.readyForRestart.length === room.players.length) {
            for (const player of room.players) {
                const stake = room.stakes[player.id] || 10;
                room.scores[player.id] = (room.scores[player.id] || 0) - stake;
                if (!player.isBot) {
                    updateUserScore(player.name, room.scores[player.id]);
                }
            }
            room.bank = Object.values(room.stakes).reduce((sum, s) => sum + s, 0);
            resetGame(room);
        }
    });

    socket.on('leaveRoom', () => {
        const room = rooms[socket.roomId];
        if (room) {
            const leavingPlayer = room.players.find((p) => p.id === socket.id);
            room.players = room.players.filter((p) => p.id !== socket.id);
            io.to(room.roomId).emit('playerLeft', {
                playerName: leavingPlayer ? leavingPlayer.name : 'Игрок',
                players: getPublicPlayers(room)
            });
            if (room.creatorId === socket.id && room.players.length > 0) {
                room.creatorId = room.players[0].id;
            }
            if (room.players.length === 0) {
                clearTimeout(room.turnTimer);
                delete rooms[socket.roomId];
            } else {
                io.to(room.roomId).emit('updatePlayers', getPublicPlayers(room));
                if (room.gameStarted && !room.guessPhase) {
                    checkGameEnd(room);
                }
            }
        }
        socket.leave(socket.roomId);
        socket.roomId = null;
    });

    socket.on('chatMessage', (message) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        const player = room.players.find((p) => p.id === socket.id);
        if (!player) return;
        if (typeof message !== 'string') return;
        const trimmed = message.trim().slice(0, 300);
        if (!trimmed) return;
        io.to(socket.roomId).emit('chatMessage', {
            name: player.name,
            message: trimmed
        });
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players = room.players.filter((p) => p.id !== socket.id);
            if (room.players.length === 0) {
                clearTimeout(room.turnTimer);
                delete rooms[socket.roomId];
            } else {
                io.to(room.roomId).emit('updatePlayers', getPublicPlayers(room));
                if (room.creatorId === socket.id && room.players.length > 0) {
                    room.creatorId = room.players[0].id;
                }
                if (room.gameStarted && !room.guessPhase) {
                    checkGameEnd(room);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});

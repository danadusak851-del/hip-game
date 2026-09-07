let socket = io();
let myCards = [];
let currentRoomId = null;
let myName = '';
let hasHip = false;
let myId = null;
let guessPhaseActive = false;
let currentGuessWinners = [];
let pendingResponseActive = false;
let userProfile = null;

const AVATAR_EMOJIS = ['🦁', '🐯', '🐺', '🦊', '🐼', '🐨', '🐸', '🐵', '🦄', '🐲', '🦉', '🐙', '🐧', '🦅', '🐳', '🦋'];
const ACHIEVEMENT_ICONS = { first_win: '🏆', ten_wins: '🔥', beat_bot: '🤖' };
const ACHIEVEMENT_NAMES = { first_win: 'Первая победа', ten_wins: 'Ветеран стола', beat_bot: 'Покоритель ботов' };
const SCREEN_DISPLAY = {
    authScreen: 'flex',
    createRoomScreen: 'flex',
    joinRoomScreen: 'flex',
    lobbyScreen: 'flex',
    gameScreen: 'block',
    ratingScreen: 'flex'
};

function avatarFor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_EMOJIS[hash % AVATAR_EMOJIS.length];
}

/* ---------------- Звук ---------------- */

let audioCtx = null;
function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function playTone(frequency, duration, type = 'sine', gain = 0.1, delay = 0) {
    const ctx = getAudioContext();
    setTimeout(() => {
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        gainNode.gain.value = gain;
        oscillator.frequency.value = frequency;
        oscillator.type = type;
        oscillator.start();
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        oscillator.stop(ctx.currentTime + duration);
    }, delay);
}

function playShuffle() {
    for (let i = 0; i < 9; i++) {
        playTone(180 + Math.random() * 420, 0.06, 'square', 0.035, i * 55);
    }
}

function playFanfare() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => playTone(f, 0.35, 'triangle', 0.12, i * 140));
}

function playSadTrombone() {
    [392, 370, 349, 330].forEach((f, i) => playTone(f, 0.4, 'sawtooth', 0.09, i * 220));
}

function playSound(type) {
    switch (type) {
        case 'play': playTone(600, 0.1, 'sine', 0.1); break;
        case 'beat': playTone(800, 0.1, 'sine', 0.1); break;
        case 'take': playTone(300, 0.2, 'sine', 0.1); break;
        case 'hip': playTone(1000, 0.3, 'sine', 0.12); break;
        case 'shuffle': playShuffle(); break;
        case 'win': playFanfare(); break;
        case 'lose': playSadTrombone(); break;
        default: playTone(440, 0.1);
    }
}

/* ---------------- Тема / экраны ---------------- */

function toggleTheme() {
    document.body.classList.toggle('light-theme');
}

function showScreen(screenId) {
    Object.keys(SCREEN_DISPLAY).forEach((id) => {
        document.getElementById(id).style.display = 'none';
    });
    document.getElementById(screenId).style.display = SCREEN_DISPLAY[screenId] || 'block';
}

/* ---------------- Тосты (достижения, банк) ---------------- */

function showToast(icon, title, name) {
    const container = document.getElementById('achievementToast');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'achievement-toast';

    const iconEl = document.createElement('div');
    iconEl.className = 'icon';
    iconEl.textContent = icon;

    const body = document.createElement('div');
    body.className = 'body';
    const titleEl = document.createElement('div');
    titleEl.className = 'title';
    titleEl.textContent = title;
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = name;
    body.appendChild(titleEl);
    body.appendChild(nameEl);

    toast.appendChild(iconEl);
    toast.appendChild(body);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

/* ---------------- Конфетти / затемнение при проигрыше ---------------- */

function launchConfetti() {
    const colors = ['#ffd166', '#ff2e63', '#4deeea', '#4ade80'];
    for (let i = 0; i < 60; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + 'vw';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDuration = 2 + Math.random() * 1.5 + 's';
        piece.style.animationDelay = Math.random() * 0.3 + 's';
        piece.style.transform = `rotate(${Math.random() * 360}deg)`;
        document.body.appendChild(piece);
        setTimeout(() => piece.remove(), 4200);
    }
}

function showLoseOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'lose-overlay';
    const text = document.createElement('div');
    text.className = 'lose-text';
    text.textContent = '😔 В этом раунде не повезло...';
    overlay.appendChild(text);
    document.body.appendChild(overlay);
    setTimeout(() => overlay.classList.add('fade-out'), 1600);
    setTimeout(() => overlay.remove(), 2200);
}

/* ---------------- Таймер хода (кольцо) ---------------- */

let timerInterval = null;
const TIMER_CIRCUMFERENCE = 163.4;

function startTimerRing(seconds = 40) {
    const ring = document.getElementById('timerRing');
    const circle = document.getElementById('timerRingProgress');
    const text = document.getElementById('timerRingText');
    if (!ring || !circle || !text) return;

    clearInterval(timerInterval);
    ring.style.display = 'block';
    circle.classList.remove('timer-warning');
    circle.style.transition = 'none';
    circle.style.strokeDashoffset = '0';
    void circle.offsetWidth; // форсируем reflow, чтобы анимация запустилась заново
    circle.style.transition = `stroke-dashoffset ${seconds}s linear`;
    requestAnimationFrame(() => {
        circle.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE);
    });

    let remaining = seconds;
    text.textContent = remaining;
    timerInterval = setInterval(() => {
        remaining -= 1;
        text.textContent = Math.max(remaining, 0);
        if (remaining <= 10) circle.classList.add('timer-warning');
        if (remaining <= 0) clearInterval(timerInterval);
    }, 1000);
}

function stopTimerRing() {
    clearInterval(timerInterval);
    const ring = document.getElementById('timerRing');
    if (ring) ring.style.display = 'none';
}

/* ---------------- Анимация полёта карты ---------------- */

function flyToCenter(cardEl) {
    if (!cardEl) return;
    const start = cardEl.getBoundingClientRect();
    const targetEl = document.getElementById('playedCardVisual');
    if (!targetEl) return;
    const target = targetEl.getBoundingClientRect();

    const clone = cardEl.cloneNode(true);
    clone.classList.add('flying-clone');
    clone.style.left = start.left + 'px';
    clone.style.top = start.top + 'px';
    clone.style.width = start.width + 'px';
    clone.style.height = start.height + 'px';
    document.body.appendChild(clone);

    requestAnimationFrame(() => {
        clone.style.left = target.left + target.width / 2 - start.width / 2 + 'px';
        clone.style.top = target.top + target.height / 2 - start.height / 2 + 'px';
        clone.style.transform = 'scale(1.1) rotate(0deg)';
        clone.style.opacity = '0.85';
    });
    setTimeout(() => clone.remove(), 420);
}

/* ---------------- Авторизация ---------------- */

function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('loginPanel').classList.toggle('active', tab === 'login');
    document.getElementById('registerPanel').classList.toggle('active', tab === 'register');
    showAuthError('');
}

function showAuthError(msg) {
    const el = document.getElementById('authError');
    if (el) el.textContent = msg || '';
}

function register() {
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    showAuthError('');
    if (!username || !password) return showAuthError('Заполните все поля');
    socket.emit('register', { username, password }, (data) => {
        if (data.error) return showAuthError(data.error);
        userProfile = { username: data.username, score: data.score, achievements: data.achievements || [] };
        myName = data.username;
        document.getElementById('authForms').style.display = 'none';
        document.getElementById('roomActions').style.display = 'block';
        updateProfileDisplay();
    });
}

function login() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    showAuthError('');
    if (!username || !password) return showAuthError('Заполните все поля');
    socket.emit('login', { username, password }, (data) => {
        if (data.error) return showAuthError(data.error);
        userProfile = { username: data.username, score: data.score, achievements: data.achievements || [] };
        myName = data.username;
        document.getElementById('authForms').style.display = 'none';
        document.getElementById('roomActions').style.display = 'block';
        updateProfileDisplay();
    });
}

function updateProfileDisplay() {
    if (!userProfile) return;
    document.getElementById('profileInfo').textContent = `${userProfile.username} — ${userProfile.score} очков`;
    const bar = document.getElementById('achievementsBar');
    if (!bar) return;
    bar.innerHTML = '';
    (userProfile.achievements || []).forEach((id) => {
        const chip = document.createElement('div');
        chip.className = 'achievement-chip';
        chip.title = ACHIEVEMENT_NAMES[id] || id;
        chip.textContent = ACHIEVEMENT_ICONS[id] || '🎖️';
        bar.appendChild(chip);
    });
}

/* ---------------- Рейтинг ---------------- */

function showRating() {
    socket.emit('getRating', (rating) => {
        const list = document.getElementById('ratingList');
        list.innerHTML = '';
        rating.forEach((player, index) => {
            const row = document.createElement('div');
            row.className = 'rating-row';

            const rank = document.createElement('span');
            rank.className = 'rank';
            rank.textContent = `#${index + 1}`;

            const name = document.createElement('span');
            name.textContent = `${avatarFor(player.username)} ${player.username}`;
            name.style.flex = '1';
            name.style.textAlign = 'left';
            name.style.marginLeft = '8px';

            const score = document.createElement('span');
            score.className = 'score';
            score.textContent = `${player.score}`;

            row.appendChild(rank);
            row.appendChild(name);
            row.appendChild(score);
            list.appendChild(row);
        });
        showScreen('ratingScreen');
    });
}

/* ---------------- Комнаты ---------------- */

function createRoom() {
    if (!userProfile) return alert('Сначала войдите в профиль');
    const stake = parseInt(document.getElementById('stakeInput').value) || 10;
    socket.emit('createRoom', userProfile.username, (data) => {
        if (data.error) return alert(data.error);
        currentRoomId = data.roomId;
        document.getElementById('roomCode').textContent = data.roomId;
        socket.emit('setStake', stake);
        showScreen('lobbyScreen');
        updatePlayers(data.players);
        myId = socket.id;
        const me = data.players.find((p) => p.id === myId);
        document.getElementById('startGameBtn').style.display = me && me.isCreator ? 'inline-block' : 'none';
    });
}

function joinRoom() {
    if (!userProfile) return alert('Сначала войдите в профиль');
    const roomId = document.getElementById('roomId').value.trim().toUpperCase();
    if (!roomId) return alert('Введите код комнаты');
    socket.emit('joinRoom', { roomId, playerName: userProfile.username }, (data) => {
        if (data.error) return alert(data.error);
        currentRoomId = data.roomId;
        document.getElementById('roomCode').textContent = data.roomId;
        showScreen('lobbyScreen');
        updatePlayers(data.players);
        myId = socket.id;
        const me = data.players.find((p) => p.id === myId);
        document.getElementById('startGameBtn').style.display = me && me.isCreator ? 'inline-block' : 'none';
    });
}

function addBot() {
    socket.emit('addBot');
}

function updatePlayers(players) {
    const list = document.getElementById('playersList');
    list.innerHTML = '';
    players.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'player-row';

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = p.isBot ? '🤖' : avatarFor(p.name);

        const meta = document.createElement('div');
        meta.className = 'meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'name';
        nameEl.textContent = p.name;
        if (p.isCreator) {
            const crown = document.createElement('span');
            crown.className = 'crown';
            crown.textContent = ' 👑';
            nameEl.appendChild(crown);
        }
        const scoreEl = document.createElement('div');
        scoreEl.className = 'score';
        scoreEl.textContent = `${p.score} очков`;

        meta.appendChild(nameEl);
        meta.appendChild(scoreEl);
        row.appendChild(avatar);
        row.appendChild(meta);
        list.appendChild(row);
    });
}

function startGame() {
    socket.emit('startGame');
}

/* ---------------- Игра ---------------- */

function renderCards() {
    const container = document.getElementById('myCards');
    container.innerHTML = '';
    if (hasHip) {
        const msg = document.createElement('div');
        msg.style.fontSize = '32px';
        msg.style.fontFamily = "'Cinzel', serif";
        msg.style.color = 'var(--gold)';
        msg.textContent = '🏆 Ты выиграл! Жди остальных...';
        container.appendChild(msg);
        return;
    }
    myCards.forEach((card, index) => {
        const cardEl = document.createElement('div');
        cardEl.className = `card ${card.suit === '♥' || card.suit === '♦' ? 'red' : 'black'}`;
        cardEl.textContent = `${card.value}${card.suit}`;
        cardEl.style.animationDelay = `${index * 0.12}s`;
        cardEl.onclick = () => {
            if (pendingResponseActive) {
                flyToCenter(cardEl);
                socket.emit('respondToCard', { action: 'beat', cardIndex: index });
            } else {
                flyToCenter(cardEl);
                playCard(index);
            }
        };
        container.appendChild(cardEl);
    });
}

function playCard(index) {
    if (hasHip || guessPhaseActive || pendingResponseActive) return;
    socket.emit('playCard', index);
    playSound('play');
}

function callHip() {
    if (guessPhaseActive) return;
    if (myCards.length === 3 && myCards.every((c) => c.suit === myCards[0].suit)) {
        hasHip = true;
        socket.emit('callHip');
        playSound('hip');
        launchConfetti();
        renderCards();
    } else {
        alert('У тебя ещё не ХИП! Нужно 3 карты одной масти');
    }
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message) return;
    socket.emit('chatMessage', message);
    input.value = '';
}

function addToHistory(playerName, card) {
    const historyDiv = document.getElementById('history');
    const entry = document.createElement('div');
    entry.textContent = `${playerName}: ${card.value}${card.suit}`;
    historyDiv.prepend(entry);
    while (historyDiv.children.length > 10) {
        historyDiv.removeChild(historyDiv.lastChild);
    }
}

function showPlayedCard(card) {
    const container = document.getElementById('playedCardVisual');
    const isRed = card.suit === '♥' || card.suit === '♦';
    container.innerHTML = '';
    const visual = document.createElement('div');
    visual.className = `visual-card ${isRed ? 'red' : 'black'}`;
    const valueEl = document.createElement('div');
    valueEl.className = 'card-value';
    valueEl.textContent = card.value;
    const suitEl = document.createElement('div');
    suitEl.className = 'card-suit';
    suitEl.textContent = card.suit;
    visual.appendChild(valueEl);
    visual.appendChild(suitEl);
    container.appendChild(visual);
}

function updatePlayersInfo(players, currentTurn) {
    const container = document.getElementById('playersInfo');
    container.innerHTML = '';
    players.forEach((player, index) => {
        const badge = document.createElement('div');
        const classes = ['player-badge'];
        if (player.id === myId) classes.push('me');
        if (player.hasHip) classes.push('hip');
        else if (player.isOut) classes.push('out');
        else if (currentTurn !== undefined && index === currentTurn) classes.push('active-turn');
        badge.className = classes.join(' ');

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = player.isBot ? '🤖' : avatarFor(player.name);
        badge.appendChild(avatar);

        const label = document.createElement('div');
        if (player.hasHip) {
            label.textContent = `✅ ${player.name}`;
        } else if (player.isOut) {
            label.textContent = `🏆 ${player.name}`;
        } else {
            label.textContent = `${player.name} (${player.cardCount})`;
        }
        badge.appendChild(label);

        container.appendChild(badge);
    });
}

function showTakeButton() {
    document.getElementById('takeButton').style.display = 'inline-block';
}

function hideTakeButton() {
    document.getElementById('takeButton').style.display = 'none';
}

function takeCard() {
    if (pendingResponseActive) {
        socket.emit('respondToCard', { action: 'take' });
        pendingResponseActive = false;
        hideTakeButton();
        playSound('take');
    }
}

function showResponsePanel(card) {
    pendingResponseActive = true;
    showTakeButton();
    document.getElementById('lastPlayed').textContent = `Тебе скинули: ${card.value}${card.suit}`;
    showPlayedCard(card);
    document.getElementById('turnIndicator').textContent = 'Твой ход (отбиваешься или забираешь)';
}

function showGuessResults(data) {
    const container = document.getElementById('guessResults');
    container.innerHTML = '';

    const h3 = document.createElement('h3');
    h3.textContent = `Результаты угадывания (${data.loserName})`;
    container.appendChild(h3);

    if (data.results.length === 0) {
        const p = document.createElement('p');
        p.style.color = 'var(--text-dim)';
        p.textContent = 'В этом раунде угадывать было некому.';
        container.appendChild(p);
    } else {
        data.results.forEach((r) => {
            const div = document.createElement('div');
            div.textContent = `${r.winnerName}: ${r.guessedSuit} → ${r.actualSuit} ${r.isCorrect ? '✅' : '❌'}`;
            container.appendChild(div);
        });
        const p = document.createElement('p');
        p.textContent = `Правильных: ${data.correctGuesses} из ${data.results.length}`;
        container.appendChild(p);
    }

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Играть снова';
    btn.onclick = readyForRestart;
    container.appendChild(btn);

    container.style.display = 'block';
}

function readyForRestart() {
    socket.emit('readyForRestart');
    document.getElementById('restartStatus').style.display = 'block';
    document.getElementById('restartStatus').textContent = 'Ожидание остальных игроков...';
}

function leaveRoom() {
    if (confirm('Вы уверены, что хотите покинуть игру?')) {
        socket.emit('leaveRoom');
        stopTimerRing();
        showScreen('authScreen');
        myCards = [];
        hasHip = false;
        pendingResponseActive = false;
        guessPhaseActive = false;
        currentRoomId = null;
        hideTakeButton();
        document.getElementById('authForms').style.display = 'none';
        document.getElementById('roomActions').style.display = 'block';
    }
}

/* ---------------- Socket-события ---------------- */

socket.on('updatePlayers', (players) => {
    updatePlayers(players);
    const me = players.find((p) => p.id === myId);
    const inLobby = document.getElementById('lobbyScreen').style.display !== 'none';
    document.getElementById('startGameBtn').style.display = me && me.isCreator && inLobby ? 'inline-block' : 'none';
});

socket.on('gameStarted', (data) => {
    showScreen('gameScreen');
    document.getElementById('trumpCard').textContent = `Козырь: ${data.trump.value}${data.trump.suit}`;
    document.getElementById('bankDisplay').textContent = `💰 Банк: ${data.bank} очков`;
    hasHip = false;
    guessPhaseActive = false;
    pendingResponseActive = false;
    hideTakeButton();
    document.getElementById('history').innerHTML = '';
    document.getElementById('guessResults').style.display = 'none';
    document.getElementById('restartStatus').style.display = 'none';
    document.getElementById('playedCardVisual').innerHTML = '';
    document.getElementById('lastPlayed').textContent = '';
    updatePlayersInfo(data.players, data.currentTurn);
    document.getElementById('turnIndicator').textContent = `Ходит: ${data.players[data.currentTurn].name}`;
    document.getElementById('deckCount').textContent = `Колода: ${data.deckCount} карт`;
    playSound('shuffle');
    startTimerRing(40);
});

socket.on('yourCards', (cards) => {
    myCards = cards;
    renderCards();
});

socket.on('cardPlayed', (data) => {
    if (data.card) {
        addToHistory(data.playerName, data.card);
        document.getElementById('lastPlayed').textContent = `${data.playerName} сбросил: ${data.card.value}${data.card.suit}`;
        showPlayedCard(data.card);
    }
    document.getElementById('deckCount').textContent = `Колода: ${data.deckCount} карт`;
    updatePlayersInfo(data.players, data.currentTurn);
    document.getElementById('turnIndicator').textContent = `Ходит: ${data.players[data.currentTurn].name}`;
    startTimerRing(40);
});

socket.on('pendingResponse', (data) => {
    showResponsePanel(data.card);
    updatePlayersInfo(data.players, undefined);
    startTimerRing(40);
});

socket.on('cardBeaten', (data) => {
    addToHistory(data.playerName, data.beatCard);
    document.getElementById('lastPlayed').textContent =
        `${data.playerName} побил ${data.beatenCard.value}${data.beatenCard.suit} картой ${data.beatCard.value}${data.beatCard.suit}`;
    showPlayedCard(data.beatCard);
    updatePlayersInfo(data.players, data.currentTurn);
    document.getElementById('deckCount').textContent = `Колода: ${data.deckCount} карт`;
    playSound('beat');
    hideTakeButton();
    pendingResponseActive = false;
    startTimerRing(40);
});

socket.on('cardTaken', (data) => {
    addToHistory(data.playerName, data.takenCard);
    document.getElementById('lastPlayed').textContent = `${data.playerName} забрал ${data.takenCard.value}${data.takenCard.suit}`;
    showPlayedCard(data.takenCard);
    updatePlayersInfo(data.players, data.currentTurn);
    document.getElementById('deckCount').textContent = `Колода: ${data.deckCount} карт`;
    playSound('take');
    hideTakeButton();
    pendingResponseActive = false;
    startTimerRing(40);
});

socket.on('turnUpdate', (data) => {
    updatePlayersInfo(data.players, data.currentTurn);
    document.getElementById('turnIndicator').textContent = `Ходит: ${data.players[data.currentTurn].name}`;
    document.getElementById('deckCount').textContent = `Колода: ${data.deckCount} карт`;
    startTimerRing(40);
});

socket.on('hipCalled', (data) => {
    document.getElementById('turnIndicator').textContent = `🎯 ${data.playerName} собрал ХИП!`;
    updatePlayersInfo(data.players, data.currentTurn);
    if (data.currentTurn !== undefined) {
        document.getElementById('turnIndicator').textContent += ` Ходит: ${data.players[data.currentTurn].name}`;
        startTimerRing(40);
    }
    if (data.playerName !== myName) {
        playSound('hip');
    }
});

socket.on('gameOver', (data) => {
    document.getElementById('turnIndicator').textContent = `🏆 Игра окончена! ${data.loser} проиграл!`;
    updatePlayersInfo(data.players, undefined);
    pendingResponseActive = false;
    hideTakeButton();
    stopTimerRing();
    if (data.loser === myName) {
        playSound('lose');
        showLoseOverlay();
    }
});

socket.on('guessPhase', (data) => {
    guessPhaseActive = true;
    currentGuessWinners = data.winners;
    const panel = document.getElementById('guessPanel');
    panel.style.display = 'block';
    const container = document.getElementById('guessContainer');
    container.innerHTML = '';
    const h3 = document.createElement('h3');
    h3.textContent = 'Угадай масть у выигравших:';
    container.appendChild(h3);
    currentGuessWinners.forEach((winner) => {
        const div = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = `${winner.name}: `;
        div.appendChild(label);
        const select = document.createElement('select');
        select.id = `guess_${winner.id}`;
        ['♠', '♥', '♦', '♣'].forEach((suit) => {
            const opt = document.createElement('option');
            opt.value = suit;
            opt.textContent = suit;
            select.appendChild(opt);
        });
        div.appendChild(select);
        container.appendChild(div);
    });
    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Отправить';
    submitBtn.onclick = submitGuesses;
    container.appendChild(submitBtn);
});

function submitGuesses() {
    const guesses = [];
    currentGuessWinners.forEach((winner) => {
        const select = document.getElementById(`guess_${winner.id}`);
        guesses.push({ playerId: winner.id, suit: select.value });
    });
    socket.emit('submitGuess', guesses);
    document.getElementById('guessPanel').style.display = 'none';
    guessPhaseActive = false;
}

socket.on('guessResults', (data) => {
    showGuessResults(data);
});

socket.on('roundWon', (data) => {
    playSound('win');
    showToast('💰', 'Банк выигран', `+${data.bank} очков`);
});

socket.on('achievementsUnlocked', (unlocked) => {
    unlocked.forEach((a) => {
        showToast(a.icon, 'Достижение открыто', a.name);
        if (userProfile && !userProfile.achievements.includes(a.id)) {
            userProfile.achievements.push(a.id);
        }
    });
    updateProfileDisplay();
});

socket.on('restartStatus', (data) => {
    const statusDiv = document.getElementById('restartStatus');
    statusDiv.textContent = `Готово: ${data.readyCount} из ${data.totalPlayers}`;
    statusDiv.style.display = 'block';
});

socket.on('playerLeft', (data) => {
    updatePlayersInfo(data.players, undefined);
    showToast('🚪', 'Игрок вышел', data.playerName);
});

socket.on('chatMessage', (data) => {
    const messages = document.getElementById('messages');
    const div = document.createElement('div');
    div.textContent = `${data.name}: ${data.message}`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
});

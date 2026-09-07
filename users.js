const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const USERS_FILE = path.join(__dirname, 'users.json');
const SALT_ROUNDS = 10;

// Разрешены только буквы (лат/рус), цифры, дефис и подчёркивание — 2-20 символов
const USERNAME_REGEX = /^[a-zA-Zа-яА-ЯёЁ0-9_-]{2,20}$/;

const ACHIEVEMENTS = {
    first_win: { id: 'first_win', name: 'Первая победа', icon: '🏆', desc: 'Выиграй свою первую игру' },
    ten_wins: { id: 'ten_wins', name: 'Ветеран стола', icon: '🔥', desc: 'Выиграй 10 игр' },
    beat_bot: { id: 'beat_bot', name: 'Покоритель ботов', icon: '🤖', desc: 'Выиграй игру, в которой участвовал бот' }
};

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Ошибка чтения users.json:', e);
    }
    return {};
}

function saveUsers(users) {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    } catch (e) {
        console.error('Ошибка записи users.json:', e);
    }
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function validateUsername(username) {
    if (typeof username !== 'string') return 'Некорректное имя';
    if (!USERNAME_REGEX.test(username)) {
        return 'Имя: 2-20 символов, только буквы/цифры/-/_ (без пробелов)';
    }
    // защита от prototype pollution через служебные имена объекта
    if (['__proto__', 'constructor', 'prototype'].includes(username.toLowerCase())) {
        return 'Это имя использовать нельзя';
    }
    return null;
}

function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 4 || password.length > 100) {
        return 'Пароль должен быть от 4 до 100 символов';
    }
    return null;
}

async function registerUser(username, password) {
    const usernameError = validateUsername(username);
    if (usernameError) return { error: usernameError };
    const passwordError = validatePassword(password);
    if (passwordError) return { error: passwordError };

    const users = loadUsers();
    if (hasOwn(users, username)) {
        return { error: 'Пользователь с таким именем уже существует' };
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    users[username] = {
        passwordHash,
        score: 10000,
        stats: { wins: 0 },
        achievements: []
    };
    saveUsers(users);
    return { username, score: 10000, achievements: [] };
}

async function loginUser(username, password) {
    const usernameError = validateUsername(username);
    // намеренно не раскрываем, что не так — имя или пароль, для защиты от перебора логинов
    if (usernameError) return { error: 'Неверное имя или пароль' };

    const users = loadUsers();
    const user = hasOwn(users, username) ? users[username] : null;
    if (!user || typeof user !== 'object') {
        return { error: 'Неверное имя или пароль' };
    }

    // Миграция старых аккаунтов, где пароль хранился в открытом виде
    if (user.password && !user.passwordHash) {
        if (user.password !== password) return { error: 'Неверное имя или пароль' };
        user.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        delete user.password;
        if (!user.stats) user.stats = { wins: 0 };
        if (!user.achievements) user.achievements = [];
        saveUsers(users);
        return { username, score: user.score, achievements: user.achievements };
    }

    if (!user.passwordHash) return { error: 'Неверное имя или пароль' };
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return { error: 'Неверное имя или пароль' };

    if (!user.stats) user.stats = { wins: 0 };
    if (!user.achievements) user.achievements = [];

    return { username, score: user.score, achievements: user.achievements };
}

function updateUserScore(username, newScore) {
    const users = loadUsers();
    if (hasOwn(users, username)) {
        users[username].score = newScore;
        saveUsers(users);
        return true;
    }
    return false;
}

function getUsers() {
    return loadUsers();
}

// Регистрирует победу пользователя и возвращает список НОВЫХ полученных достижений
function recordWin(username, { vsBot = false } = {}) {
    const users = loadUsers();
    if (!hasOwn(users, username)) return [];
    const user = users[username];
    if (!user.stats) user.stats = { wins: 0 };
    if (!user.achievements) user.achievements = [];

    user.stats.wins += 1;

    const unlocked = [];
    const tryUnlock = (id) => {
        if (!user.achievements.includes(id)) {
            user.achievements.push(id);
            unlocked.push(ACHIEVEMENTS[id]);
        }
    };

    if (user.stats.wins === 1) tryUnlock('first_win');
    if (user.stats.wins === 10) tryUnlock('ten_wins');
    if (vsBot) tryUnlock('beat_bot');

    saveUsers(users);
    return unlocked;
}

module.exports = {
    registerUser,
    loginUser,
    updateUserScore,
    getUsers,
    recordWin,
    ACHIEVEMENTS
};
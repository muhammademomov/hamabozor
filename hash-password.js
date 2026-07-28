// Генерирует bcrypt-хэш пароля для переменной окружения ADMIN_PASSWORD_HASH.
//
// Использование (после `npm install`):
//   node hash-password.js ВАШ_ПАРОЛЬ
//
// Скопируйте то, что выведется, в переменную окружения ADMIN_PASSWORD_HASH.

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Укажите пароль: node hash-password.js ВАШ_ПАРОЛЬ');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log(hash);

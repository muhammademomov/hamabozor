-- «Соберите свою покупку»: связи товаров и сценарии покупки.
-- Сервер добавляет эти колонки сам при старте (ensureProductColumns в server.js),
-- этот файл нужен только если хотите выполнить миграцию вручную.
ALTER TABLE products ADD COLUMN related_ids TEXT NULL;          -- id связанных товаров через запятую: "12,15,31"
ALTER TABLE products ADD COLUMN scenarios VARCHAR(255) NULL;    -- self,gift,home,work,trip,loved

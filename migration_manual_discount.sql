-- Выполнить один раз в Railway → MySQL → Query
-- Добавляет поле-флаг: был ли в заказе изменён индивидуально хотя бы один товар (VIP-скидка по звонку)
ALTER TABLE orders ADD COLUMN manual_discount TINYINT(1) NOT NULL DEFAULT 0 AFTER total;

-- ============================================================================
-- ХАМАБОЗОР — схема базы данных (MySQL / Railway)
-- ----------------------------------------------------------------------------
-- Как использовать:
-- В Railway откройте свою базу MySQL → вкладка "Query" (или подключитесь
-- через любой MySQL-клиент, используя данные подключения из вкладки
-- "Connect") и выполните этот скрипт целиком.
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  customer_name     VARCHAR(255) NOT NULL,
  customer_phone    VARCHAR(50)  NOT NULL,
  customer_address  VARCHAR(255),
  comment           TEXT,
  items             JSON NOT NULL,                 -- [{name, qty, price}, ...]
  total             DECIMAL(10,2) NOT NULL DEFAULT 0,
  status            ENUM('new','progress','done','cancel') NOT NULL DEFAULT 'new',
  channel           VARCHAR(20),                    -- 'whatsapp' или 'telegram'
  INDEX idx_orders_created_at (created_at)
);

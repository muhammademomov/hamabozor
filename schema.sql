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

CREATE TABLE IF NOT EXISTS products (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  cat         VARCHAR(50) NOT NULL,        -- electronics / clothing / bags
  name_ru     VARCHAR(255) NOT NULL,
  name_tj     VARCHAR(255) NOT NULL,
  price       DECIMAL(10,2) NOT NULL,
  old_price   DECIMAL(10,2),               -- если задано и больше price — на сайте показывается скидка
  emoji       VARCHAR(10) NOT NULL DEFAULT '🛍️',
  tag         VARCHAR(20),                 -- top / new / NULL
  desc_ru     TEXT,
  desc_tj     TEXT,
  rating      DECIMAL(2,1) DEFAULT 4.8,
  rating_count INT DEFAULT 0,
  colors      VARCHAR(255),                -- цвета через запятую, например "Чёрный,Синий,Красный"
  sizes       VARCHAR(255),                -- размеры через запятую, например "S,M,L,XL"
  views       INT NOT NULL DEFAULT 0,      -- счётчик просмотров страницы товара
  extra_images JSON,                        -- дополнительные фото для галереи (массив ссылок/base64)
  seller_name VARCHAR(255),                 -- имя партнёра-продавца, если товар не ваш собственный
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banners (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  image_data  MEDIUMTEXT NOT NULL,         -- фото баннера (base64)
  link_url    VARCHAR(500),                -- необязательная ссылка при клике
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

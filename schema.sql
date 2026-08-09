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

CREATE TABLE IF NOT EXISTS product_model_media (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  product_id  INT NOT NULL,
  color       VARCHAR(100),                -- цвет, к которому относится фото/видео (необязательно)
  body_type   ENUM('slim','plus') NOT NULL DEFAULT 'slim',  -- худая / полная модель
  media_type  ENUM('video','image') NOT NULL DEFAULT 'video',
  media_data  LONGTEXT NOT NULL,           -- фото/видео модели в товаре (base64)
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pmm_product (product_id)
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(50) NOT NULL UNIQUE,
  discount_type   ENUM('percent','fixed') NOT NULL DEFAULT 'percent',
  discount_value  DECIMAL(10,2) NOT NULL,
  usage_limit     INT NULL,
  expires_at      DATE NULL,
  active          TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  platform        VARCHAR(100),
  budget          DECIMAL(10,2) NOT NULL DEFAULT 0,
  start_date      DATE,
  end_date        DATE NULL,
  promo_code_id   INT NULL,
  note            VARCHAR(255),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bloggers (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  platform        VARCHAR(100),
  phone           VARCHAR(50),
  telegram        VARCHAR(255),
  deal_type       ENUM('fixed','percent') NOT NULL DEFAULT 'fixed',
  fee_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  promo_code_id   INT NULL,
  notes           TEXT,
  active          TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- в таблицу orders также добавляется: promo_code VARCHAR(50) NULL, discount_amount DECIMAL(10,2) NULL

CREATE TABLE IF NOT EXISTS owner_transactions (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  type              ENUM('contribution','withdrawal') NOT NULL,
  amount            DECIMAL(10,2) NOT NULL,
  transaction_date  DATE NOT NULL,
  note              VARCHAR(255),
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- в таблицу partners также добавляется: wholesale_payment_timing ENUM('immediate','on_sale')

CREATE TABLE IF NOT EXISTS general_expenses (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  title          VARCHAR(255) NOT NULL,
  category       VARCHAR(100),
  amount         DECIMAL(10,2) NOT NULL,
  expense_date   DATE NOT NULL,
  note           VARCHAR(255),
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS courier_payouts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  courier_id  INT NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  note        VARCHAR(255),
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- в таблицу couriers также добавляется (автоматически): salary_type ENUM('fixed','per_delivery'), salary_rate DECIMAL(10,2)

CREATE TABLE IF NOT EXISTS purchases (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  product_id     INT NOT NULL,
  qty            INT NOT NULL,
  unit_price     DECIMAL(10,2) NOT NULL,
  purchase_date  DATE NOT NULL,
  supplier       VARCHAR(255),
  note           VARCHAR(255),
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS partners (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(255) NOT NULL,
  phone               VARCHAR(50),
  telegram            VARCHAR(255),
  deal_type           ENUM('commission','wholesale') NOT NULL DEFAULT 'commission',
  commission_percent  DECIMAL(5,2) NOT NULL DEFAULT 0,
  notes               TEXT,
  active              TINYINT(1) NOT NULL DEFAULT 1,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS partner_expenses (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  partner_id            INT NOT NULL,
  title                 VARCHAR(255) NOT NULL,
  amount                DECIMAL(10,2) NOT NULL,
  partner_share_percent DECIMAL(5,2) NOT NULL DEFAULT 100,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS partner_payouts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  partner_id  INT NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  note        VARCHAR(255),
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- в таблицу products также добавляется (автоматически): partner_id INT NULL

CREATE TABLE IF NOT EXISTS couriers (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  telegram_chat_id  BIGINT NOT NULL UNIQUE,
  first_name        VARCHAR(255),
  username          VARCHAR(255),
  display_name      VARCHAR(255),
  active            TINYINT(1) NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- в таблицу orders также добавляются (автоматически при старте сервера):
--   courier_id INT NULL, delivery_status ENUM('waiting','accepted','in_transit','delivered'), telegram_broadcast JSON

CREATE TABLE IF NOT EXISTS banners (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  image_data  MEDIUMTEXT NOT NULL,         -- фото баннера (base64)
  link_url    VARCHAR(500),                -- необязательная ссылка при клике
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

create database stikermaker;

use stikermaker;

CREATE TABLE stikermaker.stickers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contact_name VARCHAR(255) NOT NULL,
  contact_id VARCHAR(255) NOT NULL,
  is_group BOOLEAN NOT NULL,
  group_name VARCHAR(255),
  file_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contact_id ON stikermaker.stickers(contact_id);
#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, '..');
const envFile = path.join(rootDir, '.env');
const configFile = path.join(rootDir, 'config.json');
const envExample = path.join(rootDir, '.env.example');
const configExample = path.join(rootDir, 'config.json.example');

console.log('🐳 开始构建 Docker 镜像...\n');

// 检查并复制 .env
if (!fs.existsSync(envFile)) {
  if (fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envFile);
    console.log('✓ 已从 .env.example 创建 .env');
  } else {
    console.warn('⚠ 未找到 .env.example，将使用默认配置');
  }
} else {
  console.log('✓ .env 已存在');
}

// 检查并复制 config.json
if (!fs.existsSync(configFile)) {
  if (fs.existsSync(configExample)) {
    fs.copyFileSync(configExample, configFile);
    console.log('✓ 已从 config.json.example 创建 config.json');
  } else {
    console.warn('⚠ 未找到 config.json.example，将使用默认配置');
  }
} else {
  console.log('✓ config.json 已存在');
}

// 确保必要的目录存在（防止 Docker 挂载时创建文件夹）
const dataDir = path.join(rootDir, 'data');
const imagesDir = path.join(rootDir, 'public', 'images');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('✓ 已创建 data 目录');
}

if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log('✓ 已创建 public/images 目录');
}

// 构建镜像
console.log('\n📦 正在构建镜像...\n');
try {
  execSync('docker compose build', { 
    cwd: rootDir, 
    stdio: 'inherit' 
  });
  console.log('\n✅ 镜像构建成功！');
  console.log('\n运行以下命令启动服务：');
  console.log('  docker compose up -d');
} catch (error) {
  console.error('\n❌ 构建失败');
  process.exit(1);
}

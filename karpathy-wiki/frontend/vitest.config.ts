import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// 前端 vitest 配置
// 为什么用 happy-dom：比 jsdom 性能更好，在 Windows 上启动快 10 倍以上
export default defineConfig({
  plugins: [vue()],
  // 与 vite.config.ts 一致：把 .ts 放在 .js 前，避免 src 下残留的陈旧 .js/.vue.js 编译产物
  // 遮蔽真实 .ts/.vue 源码（frontend-ts-js-shadowing 陷阱）。noEmit 已杜绝 vue-tsc 重新 emit，
  // 此处为双保险。
  resolve: {
    extensions: ['.mjs', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.vue', '.json'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['test/**/*.test.ts'],
    // T05745 构建复验：默认不限 worker 的线程池在 141+ API 测试后跑 web 全量门禁时
    // 曾以 0xC0000005（Windows access violation）整体崩溃。限制为 1~4 个线程，
    // 保留 happy-dom 的同进程启动速度，同时避免 Windows 上 worker 过多导致进程级崩溃。
    pool: 'threads',
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.vue'],
      
    },
  },
});




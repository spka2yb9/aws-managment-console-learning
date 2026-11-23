// Lifo が動的 import する Node 専用 / 未使用モジュールの代わり（vite.config.ts の alias）
export default class Unused {}
export class WebSocketServer {}
export class Terminal {
  constructor() { throw new Error('@lifo-sh/ui is not bundled'); }
}

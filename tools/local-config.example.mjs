/**
 * 本机配置**示例**（公开范围文件，形状说明用；它本身不含任何机器事实）。
 *
 * 真正生效的配置文件是 `.local/config.mjs`，不由本公开仓跟踪——把它按下面的形状写一份，
 * 放在仓库根的 `.local/` 下即可。也可以用环境变量临时覆盖单个字段（优先于文件）。
 *
 * 本模块只作形状参考，不会被加载；加载器只认 `.local/config.mjs`。
 */

/** @type {object} */
export default {
  // —— 宿主 node_modules 锚点树 ——
  // 离线校验、宿主接线用例、探针需要宿主包（@deepseek-ai/* 与 zod）时的解析锚点。
  // 指向一棵**真装着宿主包**的 node_modules 目录。环境变量：DSAFM_HOST_MODULES
  hostModules: String.raw`<宿主安装目录>\node_modules`,

  // —— 浏览器可执行文件 ——
  // 真实页面探针（tools/browser-shot.mjs）驱动 headless 浏览器时用。
  // 环境变量：DSAFM_BROWSER_PATH
  browserPath: String.raw`<浏览器可执行文件路径>`,

  // —— 探针输出目录 ——
  // 截图与页面转储的落点。默认写在仓库外或不由本公开仓跟踪的目录里，别污染公开范围。
  // 环境变量：DSAFM_OUTPUT_DIR
  outputDir: String.raw`<探针输出目录>`,

  // —— 具名实例 ——
  // 每个实例一组「页面 URL + 启动 token 文件」。探针用名称取用，例如
  //   const target = await instance('service');
  // token 文件是实例启动时写出的那一行 token（没有就留空，页面已带 cookie 时不需要）。
  // 按名覆盖的环境变量：DSAFM_<实例名大写>_URL / DSAFM_<实例名大写>_TOKEN_FILE
  instances: {
    service: {
      url: 'http://127.0.0.1:<端口>',
      tokenFile: String.raw`<token 文件路径>`,
    },
  },

  // 省略实例名时取哪个（默认 'default'）。环境变量：DSAFM_INSTANCE
  defaultInstance: 'service',
};

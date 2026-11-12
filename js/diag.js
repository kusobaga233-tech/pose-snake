/**
 * 摄像头环境诊断
 * ------------------------------------------------------------
 * 摄像头连不上有十几种可能原因，全都表现为"启动失败"，非常难猜。
 * 这里把 getUserMedia 的失败拆成可判定的类别，并逐项体检运行环境，
 * 让界面能直接告诉玩家"到底是哪一步卡住了、该怎么修"。
 */

/**
 * 把 getUserMedia 抛出的异常归类成玩家能看懂的行动建议
 * @param {any} err DOMException 或普通 Error
 * @returns {{code:string, title:string, reasons:string[], fixes:string[]}}
 */
export function classifyCameraError(err) {
  const name = err?.name || 'Error';
  const msg = err?.message || '';

  switch (name) {
    // 权限被拒绝 / 被策略拦截。注意：一旦拒绝，同源下重试也不会弹窗了
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        code: 'denied',
        title: '摄像头权限被拒绝',
        reasons: [
          '地址栏左侧的摄像头图标显示为"已阻止"',
          '浏览器设置里把本站的摄像头权限设成了"不允许"',
          '页面被嵌在预览窗口/iframe 里，而外层没有给摄像头权限'
        ],
        fixes: [
          '点地址栏左侧的锁形/摄像头图标 → 摄像头 → 允许 → 刷新页面',
          'Chrome 打开 chrome://settings/content/camera，确认本站不在"禁止"列表',
          'Windows 设置 → 隐私和安全性 → 摄像头 → 打开"让桌面应用访问摄像头"',
          '如果是在编辑器内置预览窗口里打开的，请把地址复制到独立的 Chrome / Edge 标签页',
          '被拒绝的权限在同一标签页内不会再次弹窗，改完设置请刷新页面'
        ]
      };

    // 系统层面找不到可用的摄像头设备
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        code: 'nodevice',
        title: '没有找到摄像头设备',
        reasons: [
          '笔记本摄像头的物理开关/快捷键被关掉了',
          '摄像头驱动没有装好，或设备被禁用',
          'Windows 隐私设置禁止了应用访问摄像头'
        ],
        fixes: [
          '按笔记本的 Fn + 摄像头快捷键（通常是 Fn+F8/F10）确认摄像头指示灯亮起',
          'Windows 设置 → 隐私和安全性 → 摄像头 → 打开"摄像头访问"和"让桌面应用访问摄像头"',
          '设备管理器 → 照相机，看是否有黄色感叹号或"已禁用"，右键启用',
          '先用 Windows 自带的"相机"应用测试，确认硬件本身可用'
        ]
      };

    // 设备存在但拿不到画面：最常见的是被别的程序占用
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        code: 'busy',
        title: '摄像头被占用或无法读取',
        reasons: [
          '腾讯会议 / 钉钉 / 微信视频 / OBS / Zoom 等程序正开着摄像头',
          '上一次的浏览器标签页没有真正释放摄像头',
          '摄像头驱动异常'
        ],
        fixes: [
          '关掉所有可能占用摄像头的程序（会议软件、录屏、直播工具）',
          '关掉其他用到摄像头的浏览器标签页，只留当前页',
          '在任务管理器里结束残留的浏览器进程后重开',
          '拔插一次 USB 摄像头（外接的情况）'
        ]
      };

    // 分辨率/帧率等约束无法满足
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        code: 'constraint',
        title: '摄像头不支持请求的画面参数',
        reasons: ['设备不支持请求的分辨率组合', '虚拟摄像头（OBS Virtual Cam 等）能力受限'],
        fixes: ['页面已自动降级重试过，若仍失败请换用物理摄像头', '关闭虚拟摄像头软件后重试']
      };

    // 启动看门狗超时：请求悬着，浏览器既不批准也不拒绝
    case 'StartTimeoutError':
      return {
        code: 'timeout',
        title: '启动超时：浏览器没有回应',
        reasons: [
          '浏览器弹出了权限询问，但一直没点「允许」',
          '权限弹窗被嵌入式预览窗口 / iframe 吞掉了，请求一直悬着',
          '摄像头被其他程序占用，驱动迟迟不返回',
          '姿态模型的 CDN 请求被网络挂起，一直等不到结果',
          '上一次启动的页面还占着摄像头，没被真正释放'
        ],
        fixes: [
          '刚才只是没来得及点「允许」的话，直接点「重新尝试」即可',
          '把地址复制到独立的 Chrome / Edge 标签页打开，不要在编辑器内置预览里点',
          '点地址栏左侧的摄像头图标，把权限改成「允许」后刷新页面',
          '关掉腾讯会议 / 录屏 / OBS 等可能占用摄像头的程序',
          '换网络（手机热点最快）确认模型 CDN 能访问',
          '不想再等，直接点下面的「先用方向键玩」，游戏本体完全可玩'
        ]
      };

    // 摄像头已经通了，但姿态模型没加载起来。
    // 项目现在自带 vendor 本地包，这类失败基本只剩两种情况：
    // 当前静态服务不提供 vendor 目录，或本地包损坏且在线 CDN 也不通。
    case 'ModelLoadError': {
      const src = err?.assetSource || '未知来源';
      const tried = err?.assetTried || [];
      const localPath = err?.assetDetail || '';
      return {
        code: 'model',
        title: '摄像头已连上，但姿态模型没加载起来',
        reasons: [
          `本次模型资源：${src}`,
          ...(tried.length ? [`资源探测：${tried.join('、')}`] : []),
          ...(localPath ? [`本地包应位于：${localPath}`] : []),
          '当前页面所在的静态服务没能提供 vendor/mediapipe 目录（编辑器内置预览常见）',
          'vendor 里的文件缺失或损坏，且在线 CDN 被网络 / 代理 / CSP 拦截'
        ],
        fixes: [
          '最稳：双击项目里的 start.bat，在独立标签页打开 http://127.0.0.1:8123/ —— 该服务器提供本地模型包，完全不需要外网',
          '确认 vendor/mediapipe 下有 vision_bundle.js、wasm/ 内两个 wasm 与 js、pose_landmarker_lite.task',
          '换网络（手机热点最快）验证在线 CDN；开了代理就确认对 jsdelivr.net / storage.googleapis.com 生效',
          '在独立 Chrome / Edge 标签页里 Ctrl+F5 强刷，不要在编辑器内置预览面板里点摄像头',
          '临时点下面的「先用方向键玩」即可开玩，进游戏后右上角「重连体感」可再试'
        ]
      };
    }

    // 浏览器不支持相关 API，或运行在拿不到设备的环境里（无头/远程/嵌入式预览）
    case 'NotSupportedError':
      return {
        code: 'unsupported',
        title: '当前环境无法调用摄像头',
        reasons: [
          '浏览器版本过旧，缺少 getUserMedia',
          '页面跑在无头浏览器 / 远程桌面 / 虚拟环境里，没有真实摄像头',
          '是嵌入式浏览器或编辑器内置预览窗口，被策略禁用了摄像头'
        ],
        fixes: [
          '用最新版 Chrome 或 Edge 打开，并确认不是编辑器内置预览窗口',
          '复制下面的地址到独立标签页：http://127.0.0.1:8123/',
          '确认这台机器有可用摄像头（笔记本自带摄像头或外接 USB）',
          'Safari / Firefox 对 MediaPipe 兼容性较差，不推荐'
        ]
      };

    default:
      return {
        code: 'unknown',
        title: '摄像头启动失败',
        reasons: [msg || '未识别的错误'],
        fixes: [
          '刷新页面重试',
          '确认用的是最新的 Chrome / Edge',
          '换一个浏览器试试（Safari / Firefox 对 MediaPipe 的兼容性较差）'
        ]
      };
  }
}

/**
 * 逐项体检运行环境，返回可直接渲染成列表的结果
 * 每项：{ label, ok: true|false|null, detail }
 *   ok=true  通过
 *   ok=false 明确有问题
 *   ok=null  仅供参考/无法判定
 */
export async function collectEnv() {
  const rows = [];

  // 1. 安全上下文：非 https 且非 localhost 时，浏览器会直接隐藏 mediaDevices
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  rows.push({
    label: '页面来源',
    ok: window.isSecureContext ? true : false,
    detail: `${location.protocol}//${location.host}${window.isSecureContext ? '' : '（非安全上下文）'}`
  });

  rows.push({
    label: '安全上下文要求',
    ok: window.isSecureContext ? true : false,
    detail: window.isSecureContext
      ? (isLocal ? 'localhost 视为安全，符合要求' : 'https，符合要求')
      : '必须用 https 或 localhost 打开，file:// 和局域网 IP 都不行'
  });

  // 2. mediaDevices API 是否存在
  const hasApi = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  rows.push({
    label: 'getUserMedia 接口',
    ok: hasApi,
    detail: hasApi ? '可用' : '不可用（多为非安全上下文或被浏览器策略禁用）'
  });

  if (!hasApi) return rows;

  // 3. 权限状态（Chrome/Edge 支持 camera；Firefox 会抛错，属于正常）
  try {
    if (navigator.permissions?.query) {
      const st = await navigator.permissions.query({ name: 'camera' });
      const map = { granted: '已允许', denied: '已拒绝', prompt: '尚未询问' };
      rows.push({
        label: '摄像头权限',
        ok: st.state === 'granted' ? true : st.state === 'denied' ? false : null,
        detail: map[st.state] || st.state
      });
    } else {
      rows.push({ label: '摄像头权限', ok: null, detail: '当前浏览器不支持查询，跳过' });
    }
  } catch {
    rows.push({ label: '摄像头权限', ok: null, detail: '当前浏览器不支持查询，跳过' });
  }

  // 4. 设备枚举：只是为了给"有没有设备"提供旁证
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const cams = list.filter((d) => d.kind === 'videoinput');
    const named = cams.filter((d) => d.label);
    rows.push({
      label: '检测到的摄像头',
      ok: cams.length > 0 ? true : false,
      detail: cams.length === 0
        ? '0 个（系统层面就没有可用设备）'
        : `${cams.length} 个${named.length ? '：' + named.map((d) => d.label).join(' / ') : '（未授权前设备名为空，属正常）'}`
    });
  } catch {
    rows.push({ label: '检测到的摄像头', ok: null, detail: '枚举设备失败' });
  }

  // 5. 浏览器信息，方便排查兼容性
  rows.push({
    label: '浏览器',
    ok: null,
    detail: navigator.userAgent.replace(/^Mozilla\/5\.0\s*/, '').slice(0, 90)
  });

  return rows;
}

/**
 * 分级尝试打开摄像头
 * 先按理想参数请求；失败就逐级放宽。权限被拒绝时立刻停止（重试无意义且会反复弹窗）
 * @param {{camWidth:number, camHeight:number}} cfg
 * @returns {Promise<MediaStream>}
 */
export async function openCameraStream(cfg) {
  // 从"最理想"到"只要能出画面就行"
  const ladder = [
    { video: { facingMode: 'user', width: { ideal: cfg.camWidth }, height: { ideal: cfg.camHeight } }, audio: false },
    { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: true, audio: false }
  ];

  let firstErr = null;
  for (let i = 0; i < ladder.length; i++) {
    try {
      return await navigator.mediaDevices.getUserMedia(ladder[i]);
    } catch (e) {
      if (!firstErr) firstErr = e;
      // 权限被拒绝 / 无设备：换约束条件也没用，直接上报
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ||
          e?.name === 'NotFoundError' || e?.name === 'NotReadableError') {
        throw e;
      }
      // 其余（约束不满足等）继续放宽
    }
  }
  throw firstErr || new Error('无法打开摄像头');
}

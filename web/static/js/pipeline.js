/**
 * Pipeline 前端逻辑 — 视频 Demo / 摄像头 Demo
 *
 * 视频 Demo：后端推理，实时 MJPEG 推流到前端，不保存输出视频
 * 摄像头 Demo：浏览器/服务器摄像头，实时推流识别
 */

const PIPE_API = '/api/pipeline';

// ── Tab 切换 ──
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.toggle('active', el.id === `tab-${tabName}`);
  });
  // 按需加载数据
  if (tabName === 'video-demo') {
    loadVideoList();
    loadTaskHistory();
  } else if (tabName === 'camera-demo') {
    onCameraSourceChange();
  } else if (tabName === 'database') {
    if (typeof loadShips === 'function') loadShips();
  }
}

// ═══════════════════════════════════════════
// 视频 Demo
// ═══════════════════════════════════════════

let selectedVideo = null;
let currentTaskId = null;
let statusPollTimer = null;
let _webrtcPC = null;         // WebRTC PeerConnection (视频推流)

// ── 视频上传 ──
const videoUploadZone = document.getElementById('videoUploadZone');
const videoFileInput = document.getElementById('videoFileInput');

if (videoFileInput) {
  videoFileInput.addEventListener('change', function (e) {
    if (e.target.files.length > 0) handleVideoUpload(e.target.files[0]);
  });
}

if (videoUploadZone) {
  videoUploadZone.addEventListener('dragover', function (e) {
    e.preventDefault(); e.stopPropagation();
    this.classList.add('dragover');
  });
  videoUploadZone.addEventListener('dragleave', function (e) {
    e.preventDefault(); e.stopPropagation();
    this.classList.remove('dragover');
  });
  videoUploadZone.addEventListener('drop', function (e) {
    e.preventDefault(); e.stopPropagation();
    this.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleVideoUpload(e.dataTransfer.files[0]);
  });
}

async function handleVideoUpload(file) {
  const allowedExts = ['.mp4', '.avi', '.mkv', '.mov', '.flv', '.wmv', '.webm'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowedExts.includes(ext)) {
    showToast('不支持的视频格式: ' + ext, 'error');
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    showToast('文件过大，最大 500MB', 'error');
    return;
  }

  document.getElementById('videoUploadFilename').textContent = file.name;
  const progressWrap = document.getElementById('videoUploadProgress');
  const progressBar = document.getElementById('videoProgressBar');
  const progressText = document.getElementById('videoProgressText');
  progressWrap.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = '上传中...';

  try {
    const formData = new FormData();
    formData.append('file', file);

    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${PIPE_API}/videos/upload`);

      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = pct + '%';
          progressText.textContent = pct + '%';
        }
      });

      xhr.addEventListener('load', function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          let msg = '上传失败';
          try { msg = JSON.parse(xhr.responseText).detail || msg; } catch {}
          reject(new Error(msg));
        }
      });

      xhr.addEventListener('error', () => reject(new Error('网络错误')));
      xhr.send(formData);
    });

    showToast(`✅ 视频已上传: ${result.filename}`);
    progressBar.style.width = '100%';
    progressText.textContent = '完成!';
    setTimeout(() => { progressWrap.style.display = 'none'; }, 2000);
    loadVideoList();
  } catch (e) {
    showToast('上传失败: ' + e.message, 'error');
    progressWrap.style.display = 'none';
  }

  videoFileInput.value = '';
}

// ── 视频列表 ──
async function loadVideoList() {
  const container = document.getElementById('videoList');
  if (!container) return;
  try {
    const resp = await fetch(`${PIPE_API}/videos`);
    const data = await resp.json();
    if (!data.videos.length) {
      container.innerHTML = '<div class="empty-msg">暂无视频，请上传</div>';
      return;
    }
    container.innerHTML = data.videos.map(v => `
      <div class="video-item ${selectedVideo === v.filename ? 'selected' : ''}"
           onclick="selectVideo(this.dataset.name, this)" data-name="${safeAttr(v.filename)}">
        <div class="video-item-icon">🎬</div>
        <div class="video-item-info">
          <div class="video-item-name">${escHtml(v.filename)}</div>
          <div class="video-item-meta">${v.size_mb} MB</div>
        </div>
        <div class="video-item-actions">
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteVideo(this.dataset.name)" data-name="${safeAttr(v.filename)}">🗑️</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty-msg">加载失败: ${e.message}</div>`;
  }
}

function selectVideo(filename, el) {
  // 如果有 pipeline 在运行，先提示用户
  if (currentTaskId) {
    if (!confirm('当前有 Pipeline 正在运行，切换视频将停止当前任务。是否继续？')) return;
    stopVideoPipeline();
  }

  selectedVideo = filename;
  document.getElementById('pipelineControl').style.display = '';
  // 更新选中状态
  document.querySelectorAll('.video-item').forEach(item => item.classList.remove('selected'));
  if (el) el.classList.add('selected');

  // 重置结果区域
  const resultPlaceholder = document.getElementById('resultPlaceholder');
  if (resultPlaceholder) {
    resultPlaceholder.innerHTML = '<span>🎬</span><p>点击"开始处理"后实时显示</p>';
    resultPlaceholder.className = 'video-placeholder';
    resultPlaceholder.style.cssText = '';
    resultPlaceholder.style.display = '';
  }
  resetPipelineStatus();
}

async function deleteVideo(filename) {
  if (!confirm(`确定删除视频 "${filename}"？`)) return;
  try {
    const resp = await fetch(`${PIPE_API}/videos/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '删除失败');
    showToast('已删除: ' + filename);
    if (selectedVideo === filename) {
      selectedVideo = null;
      document.getElementById('pipelineControl').style.display = 'none';
    }
    loadVideoList();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ── Pipeline 控制 ──

/** 收集视频 Demo 页的 pipeline 参数 */
function collectVideoParams() {
  return {
    conf_threshold: parseFloat(document.getElementById('optConf').value),
    iou_threshold: parseFloat(document.getElementById('optIou').value),
    process_every: parseInt(document.getElementById('optProcessEvery').value, 10),
    detect_every: parseInt(document.getElementById('optDetectEvery').value, 10),
    target_fps: parseFloat(document.getElementById('optTargetFps').value) || 0,
    max_frames: parseInt(document.getElementById('optMaxFrames').value, 10) || 0,
    device: document.getElementById('optDevice').value,
    yolo_model: document.getElementById('optYoloModel').value.trim(),
    prompt_mode: document.getElementById('optPromptMode').value,
    enable_refresh: document.getElementById('optEnableRefresh').checked,
    gap_num: parseInt(document.getElementById('optGapNum').value, 10) || 150,
    max_concurrent: parseInt(document.getElementById('optMaxConcurrent').value, 10) || 4,
  };
}

/** 收集摄像头页的 pipeline 参数 */
function collectCameraParams() {
  return {
    conf_threshold: parseFloat(document.getElementById('camConf').value),
    iou_threshold: parseFloat(document.getElementById('camIou').value),
    process_every: parseInt(document.getElementById('camProcessEvery').value, 10),
    detect_every: parseInt(document.getElementById('camDetectEvery').value, 10),
    target_fps: parseFloat(document.getElementById('camTargetFps').value) || 0,
    capture_fps: parseInt(document.getElementById('camCaptureFps').value, 10) || 15,
    max_frames: parseInt(document.getElementById('camMaxFrames').value, 10) || 0,
    device: document.getElementById('camDevice').value,
    yolo_model: document.getElementById('camYoloModel').value.trim(),
    prompt_mode: document.getElementById('camPromptMode').value,
    enable_refresh: document.getElementById('camEnableRefresh').checked,
    gap_num: parseInt(document.getElementById('camGapNum').value, 10) || 150,
    max_concurrent: parseInt(document.getElementById('camMaxConcurrent').value, 10) || 4,
    stream_mode: (document.getElementById('camStreamMode') || {}).value || 'mjpeg',
  };
}

async function startVideoPipeline() {
  if (!selectedVideo) { showToast('请先选择视频', 'error'); return; }

  const btn = document.getElementById('btnStartPipeline');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> 启动中...';

  try {
    const resp = await fetch(`${PIPE_API}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_filename: selectedVideo,
        concurrent_mode: document.getElementById('optConcurrent').checked,
        ...collectVideoParams(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '启动失败');

    currentTaskId = data.task_id;
    showToast(`Pipeline 已启动 (${currentTaskId})`);
    updatePipelineStatus('running', '处理中...');
    document.getElementById('btnStartPipeline').style.display = 'none';
    document.getElementById('btnStopPipeline').style.display = '';

    // 实时预览：H.264 WebSocket 推流 + MSE 播放
    const resultPlaceholder = document.getElementById('resultPlaceholder');
    if (resultPlaceholder) {
      resultPlaceholder.innerHTML = `
        <video id="streamVideo" class="demo-video" autoplay muted playsinline></video>
        <div id="streamFps" style="text-align:center;font-size:12px;color:#888;margin-top:4px">连接中...</div>
      `;
      resultPlaceholder.style.background = 'transparent';
      resultPlaceholder.style.border = 'none';
    }

    connectStreamWebRTC(currentTaskId);
    startStatusPolling();
  } catch (e) {
    showToast('启动失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '▶ 开始处理';
  }
}

/** 建立 WebRTC 连接接收视频流 */
async function connectStreamWebRTC(taskId) {
  disconnectStreamWebRTC();

  const videoEl = document.getElementById('streamVideo');
  if (!videoEl) return;

  try {
    const pc = new RTCPeerConnection({
      iceServers: [{urls: "stun:stun.l.google.com:19302"}, {urls: "stun:stun1.l.google.com:19302"}]
    });
    _webrtcPC = pc;

    // 接收服务器视频轨道
    pc.ontrack = (event) => {
      console.log('收到视频轨道:', event.track.kind);
      if (event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
        videoEl.play().catch(() => {
          videoEl.muted = true;
          videoEl.play().catch(() => {});
        });
      }
    };

    // DataChannel 接收控制消息（检测结果、状态等）
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'done') {
            disconnectStreamWebRTC();
            const fpsEl = document.getElementById('streamFps');
            if (fpsEl) fpsEl.textContent = '处理完成';
          } else if (msg.type === 'detections') {
            // 渲染检测框（预留接口）
            renderDetections(msg.data);
          } else if (msg.type === 'status') {
            updatePipelineStatus(msg.status, msg.progress || '');
          }
        } catch {}
      };
    };

    pc.onconnectionstatechange = () => {
      console.log('WebRTC 连接状态:', pc.connectionState);
      if (pc.connectionState === 'failed') {
        showToast('WebRTC 连接失败', 'error');
        disconnectStreamWebRTC();
      }
    };

    // ICE 候选收集（带超时）
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 3000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    // 发送 offer 给服务器
    const resp = await fetch(`${PIPE_API}/webrtc/signal/${taskId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || 'WebRTC 信令失败');
    }

    const answer = await resp.json();
    await pc.setRemoteDescription(new RTCSessionDescription(answer));

    const fpsEl = document.getElementById('streamFps');
    if (fpsEl) fpsEl.textContent = 'WebRTC 已连接';

  } catch (e) {
    console.error('WebRTC 连接失败:', e);
    showToast('WebRTC 连接失败: ' + e.message, 'error');
    disconnectStreamWebRTC();
  }
}

/** 断开 WebRTC 视频推流 */
function disconnectStreamWebRTC() {
  if (_webrtcPC) {
    _webrtcPC.onconnectionstatechange = null;
    _webrtcPC.ontrack = null;
    _webrtcPC.close();
    _webrtcPC = null;
  }
  const videoEl = document.getElementById('streamVideo');
  if (videoEl) {
    videoEl.pause();
    videoEl.srcObject = null;
  }
}

// ── 视频 Demo H.264 WebSocket 推流 ──
let _streamH264Ws = null;
let _streamH264MediaSource = null;
let _streamH264SourceBuffer = null;
let _streamH264Queue = [];

/** H.264 WebSocket 推流接收（视频 Demo 用，替代 WebRTC） */
function connectStreamH264(taskId) {
  disconnectStreamH264();

  const videoEl = document.getElementById('streamVideo');
  if (!videoEl) return;

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${location.host}${PIPE_API}/ws/h264/${taskId}`;

  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  videoEl.load();
  _streamH264MediaSource = ms;
  _streamH264SourceBuffer = null;
  _streamH264Queue = [];

  ms.addEventListener('sourceopen', () => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    _streamH264Ws = ws;

    let frameCount = 0;
    let fpsTimer = performance.now();

    function _processQueue() {
      const sb = _streamH264SourceBuffer;
      if (!sb || sb.updating) return;
      try {
        const vEl = document.getElementById('streamVideo');
        if (vEl && sb.buffered.length > 0 && sb.buffered.start(0) < vEl.currentTime - 8) {
          sb.remove(sb.buffered.start(0), vEl.currentTime - 3);
          return;
        }
      } catch (e) {}
      if (_streamH264Queue.length > 0) {
        try { sb.appendBuffer(_streamH264Queue.shift()); } catch (e) {
          if (e.name === 'QuotaExceededError') {
            _streamH264Queue.length = 0;
            try {
              const vEl = document.getElementById('streamVideo');
              if (vEl && sb.buffered.length > 0) sb.remove(sb.buffered.start(0), vEl.currentTime);
            } catch (e2) {}
          }
        }
      }
    }

    ws.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        const view = new DataView(evt.data);
        const msgType = view.getUint8(0);
        const payload = evt.data.slice(5);

        if (msgType === 0x01) {
          // Init segment
          if (_streamH264SourceBuffer) {
            if (!_streamH264SourceBuffer.updating) {
              try { _streamH264SourceBuffer.appendBuffer(payload); } catch (e) {}
            }
            return;
          }
          try {
            if (ms.readyState !== 'open') return;
            const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42C01F"');
            _streamH264SourceBuffer = sb;
            sb.addEventListener('updateend', () => { _processQueue(); });
            sb.appendBuffer(payload);
          } catch (e) {
            console.error('MSE SourceBuffer 创建失败:', e);
          }
        } else if (msgType === 0x02) {
          // Media segment
          const sb = _streamH264SourceBuffer;
          if (!sb) return;
          if (sb.updating) {
            if (_streamH264Queue.length >= 12) _streamH264Queue = _streamH264Queue.slice(-6);
            _streamH264Queue.push(payload);
          } else {
            try { sb.appendBuffer(payload); } catch (e) {
              if (e.name === 'QuotaExceededError') {
                try {
                  const vEl = document.getElementById('streamVideo');
                  if (vEl && sb.buffered.length > 0) sb.remove(sb.buffered.start(0), vEl.currentTime - 2);
                } catch (e2) {}
                _streamH264Queue.unshift(payload);
              }
            }
          }
          frameCount++;
          const now = performance.now();
          if (now - fpsTimer > 1000) {
            const fps = (frameCount * 1000 / (now - fpsTimer)).toFixed(1);
            const fpsEl = document.getElementById('streamFps');
            if (fpsEl) fpsEl.textContent = `${fps} seg/s`;
            frameCount = 0;
            fpsTimer = now;
          }
        }
      } else {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'done') {
            disconnectStreamH264();
            const fpsEl = document.getElementById('streamFps');
            if (fpsEl) fpsEl.textContent = '处理完成';
          }
        } catch {}
      }
    };

    ws.onclose = () => {
      if (currentTaskId === taskId) {
        _scheduleReconnect('h264-stream', () => {
          if (currentTaskId === taskId) connectStreamH264(taskId);
        }, taskId);
      }
    };
    ws.onerror = () => {};

    const fpsEl = document.getElementById('streamFps');
    if (fpsEl) fpsEl.textContent = 'WebSocket H.264 已连接';
  });
}

function disconnectStreamH264() {
  _clearReconnect('h264-stream');
  if (_streamH264Ws) { _streamH264Ws.onclose = null; _streamH264Ws.close(); _streamH264Ws = null; }
  if (_streamH264MediaSource && _streamH264MediaSource.readyState === 'open') {
    try { _streamH264MediaSource.endOfStream(); } catch {}
  }
  _streamH264MediaSource = null;
  _streamH264SourceBuffer = null;
  _streamH264Queue = [];
  const videoEl = document.getElementById('streamVideo');
  if (videoEl) { videoEl.pause(); videoEl.src = ''; }
  const fpsEl = document.getElementById('streamFps');
  if (fpsEl) fpsEl.textContent = '';
}

/** 渲染检测框（WebRTC DataChannel 接收） */
function renderDetections(detections) {
  // 预留接口：后续在视频上绘制检测框
  // detections 格式: [{x, y, w, h, label, conf}, ...]
  if (!detections || !detections.length) return;
  // TODO: 在 #streamVideo 上叠加 canvas 绘制检测框
}

async function stopVideoPipeline() {
  if (!currentTaskId) return;
  const taskId = currentTaskId;

  // 立即停止轮询，防止后续 pollTaskStatus 干扰新任务
  stopStatusPolling();
  currentTaskId = null;

  // 断开 WebRTC 推流
  disconnectStreamWebRTC();

  // 更新 UI 状态
  updatePipelineStatus('failed', '正在停止...');
  resetPipelineButtons();

  try {
    const resp = await fetch(`${PIPE_API}/stop/${taskId}`, { method: 'POST' });
    if (resp.ok || resp.status === 404) {
      showToast('已停止');
    } else {
      const data = await resp.json().catch(() => ({}));
      showToast('停止: ' + (data.message || '完成'), 'info');
    }
  } catch (e) {
    showToast('已停止', 'info');
  }

  // 恢复结果占位
  _restoreResultPlaceholder();

  loadTaskHistory();
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollTimer = setInterval(pollTaskStatus, 2000);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

async function pollTaskStatus() {
  // 快照当前任务 ID，防止请求返回时 currentTaskId 已变为新任务
  const taskId = currentTaskId;
  if (!taskId) return;
  try {
    const resp = await fetch(`${PIPE_API}/status/${taskId}`);
    if (resp.status === 404) {
      if (currentTaskId === taskId) {
        stopStatusPolling();
        resetPipelineButtons();
        currentTaskId = null;
      }
      return;
    }
    const data = await resp.json();
    updatePipelineStatus(data.status, data.progress || data.error || '');

    if (data.status === 'completed') {
      if (currentTaskId === taskId) {
        stopStatusPolling();
        resetPipelineButtons();
        disconnectStreamWebRTC();
        showToast('✅ 处理完成!');
        const resultPlaceholder = document.getElementById('resultPlaceholder');
        if (resultPlaceholder) {
          resultPlaceholder.innerHTML = '<span>✅</span><p>处理完成</p>';
          resultPlaceholder.className = 'video-placeholder';
          resultPlaceholder.style.cssText = '';
        }
        loadTaskHistory();
        currentTaskId = null;
      }
    } else if (data.status === 'failed') {
      if (currentTaskId === taskId) {
        stopStatusPolling();
        resetPipelineButtons();
        disconnectStreamWebRTC();
        _restoreResultPlaceholder();
        const errorMsg = data.error || '未知错误';
        if (errorMsg === '用户手动停止') {
          showToast('已停止', 'info');
        } else {
          showToast('处理失败: ' + errorMsg, 'error');
        }
        loadTaskHistory();
        currentTaskId = null;
      }
    }
  } catch (e) {
    console.error('状态轮询失败:', e);
  }
}

function updatePipelineStatus(status, text) {
  const dot = document.querySelector('#pipelineStatus .status-dot');
  const statusText = document.getElementById('pipelineStatusText');
  if (!dot || !statusText) return;
  dot.className = 'status-dot ' + (status === 'running' ? 'running' : status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'idle');
  statusText.textContent = text || status;
}

function resetPipelineStatus() {
  updatePipelineStatus('idle', '等待开始');
  resetPipelineButtons();
}

function resetPipelineButtons() {
  const startBtn = document.getElementById('btnStartPipeline');
  const stopBtn = document.getElementById('btnStopPipeline');
  if (startBtn) startBtn.style.display = '';
  if (stopBtn) stopBtn.style.display = 'none';
}

/** 恢复结果区域为初始占位状态 */
function _restoreResultPlaceholder() {
  const resultPlaceholder = document.getElementById('resultPlaceholder');
  if (resultPlaceholder) {
    resultPlaceholder.innerHTML = '<span>🎬</span><p>点击"开始处理"后实时显示</p>';
    resultPlaceholder.className = 'video-placeholder';
    resultPlaceholder.style.cssText = '';
  }
}

// ── 任务历史 ──
async function loadTaskHistory() {
  const container = document.getElementById('taskHistory');
  if (!container) return;
  try {
    const resp = await fetch(`${PIPE_API}/status`);
    const data = await resp.json();
    if (!data.tasks.length) {
      container.innerHTML = '<div class="empty-msg">暂无任务</div>';
      return;
    }
    container.innerHTML = data.tasks.map(t => {
      const statusIcon = t.status === 'completed' ? '✅' : t.status === 'running' ? '⏳' : '❌';
      const statusClass = t.status === 'completed' ? 'success' : t.status === 'running' ? 'running' : 'error';
      const cameraTag = t.is_camera ? ' <span style="color:#f57c00;font-size:12px">[摄像头]</span>' : '';
      return `
        <div class="task-item ${statusClass}">
          <div class="task-icon">${statusIcon}</div>
          <div class="task-info">
            <div class="task-name">${escHtml(t.video_filename)}${cameraTag}</div>
            <div class="task-meta">
              任务 ${escHtml(t.task_id)} · ${escHtml(t.progress || t.error || t.status)}
            </div>
          </div>
          <div class="task-actions">
            ${t.status === 'running' ? `<button class="btn btn-danger btn-sm" onclick="stopTaskById(this.dataset.id)" data-id="${safeAttr(t.task_id)}">⏹ 停止</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty-msg">加载失败: ${e.message}</div>`;
  }
}

async function clearTaskHistory() {
  try {
    const resp = await fetch(`${PIPE_API}/tasks/clear`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '清空失败');
    showToast(data.message || '已清空');
    loadTaskHistory();
  } catch (e) {
    showToast('清空失败: ' + e.message, 'error');
  }
}

async function stopTaskById(taskId) {
  try {
    await fetch(`${PIPE_API}/stop/${taskId}`, { method: 'POST' });
    showToast('已停止');
    loadTaskHistory();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ═══════════════════════════════════════════
// 摄像头 Demo
// ═══════════════════════════════════════════

let cameraTaskId = null;
let cameraPollTimer = null;
let browserCameraStream = null;   // MediaStream
let _camWebRTCPC = null;          // 摄像头 WebRTC PeerConnection

function onCameraSourceChange() {
  const sel = document.getElementById('cameraSource');
  if (!sel) return;
  const val = sel.value;
  const urlInput = document.getElementById('cameraUrl');
  const previewRow = document.getElementById('browserCameraPreviewRow');
  const streamModeRow = document.getElementById('camStreamModeRow');
  const streamModeHint = document.getElementById('camStreamModeHint');

  if (urlInput) {
    urlInput.style.display = (val === '0' || val === 'browser') ? 'none' : '';
    if (val === 'rtsp') {
      urlInput.placeholder = 'rtsp://192.168.1.100/stream';
    } else if (val === 'custom') {
      urlInput.placeholder = '输入视频路径或 URL';
    }
  }

  if (previewRow) {
    previewRow.style.display = val === 'browser' ? '' : 'none';
  }

  // H264/MJPEG 切换仅对浏览器摄像头可见；非浏览器时显示提示
  const isBrowser = val === 'browser';
  if (streamModeRow) streamModeRow.style.display = isBrowser ? '' : 'none';
  if (streamModeHint) streamModeHint.style.display = isBrowser ? 'none' : '';
}

function getCameraInput() {
  const sel = document.getElementById('cameraSource');
  if (!sel) return '';
  if (sel.value === '0') return '0';
  if (sel.value === 'browser') return '__browser__';
  const urlInput = document.getElementById('cameraUrl');
  return urlInput ? urlInput.value.trim() : '';
}

// ── 浏览器摄像头：启动 ──
async function startBrowserCamera() {
  const btn = document.getElementById('btnStartCamera');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> 启动中...';

  const streamMode = (document.getElementById('camStreamMode') || {}).value || 'mjpeg';

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前页面不是安全上下文（需要 HTTPS 或 localhost），浏览器不允许访问摄像头');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
      audio: false,
    }).catch(err => {
      if (err.name === 'NotAllowedError') throw new Error('摄像头权限被拒绝，请在浏览器弹窗中点击"允许"');
      if (err.name === 'NotFoundError') throw new Error('未检测到摄像头设备，请确认电脑有可用摄像头');
      if (err.name === 'NotReadableError') throw new Error('摄像头被其他程序占用，请关闭其他使用摄像头的应用');
      throw new Error('摄像头访问失败: ' + err.message);
    });
    browserCameraStream = stream;

    const preview = document.getElementById('browserCameraPreview');
    const placeholder = document.getElementById('browserCameraPreviewPlaceholder');
    if (preview) {
      preview.srcObject = stream;
      preview.style.display = '';
    }
    if (placeholder) placeholder.style.display = 'none';

    const params = collectCameraParams();
    const resp = await fetch(`${PIPE_API}/start-browser-camera`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        concurrent_mode: document.getElementById('camOptConcurrent').checked,
        stream_mode: streamMode,
        ...params,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '启动失败');

    cameraTaskId = data.task_id;

    // 使用 WebRTC 模式（超低延迟）
    setupWebRTCCamera(cameraTaskId, stream);

  } catch (e) {
    showToast('启动失败: ' + e.message, 'error');
    stopBrowserCamera();
  } finally {
    btn.disabled = false;
    btn.innerHTML = '▶ 启动摄像头识别';
  }
}

/** WebRTC 模式：浏览器直连服务器，超低延迟推流 */
function setupWebRTCCamera(taskId, stream) {
  let pc = null;

  async function connect() {
    try {
      pc = new RTCPeerConnection({
        iceServers: [{urls: "stun:stun.l.google.com:19302"}, {urls: "stun:stun1.l.google.com:19302"}]
      });

      // 添加摄像头轨道
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // ICE 候选收集（带超时，防止永远挂起）
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          // 超时也继续，用已收集的候选
          resolve();
        }, 3000);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      // 发送 offer 给服务器
      const resp = await fetch(`${PIPE_API}/webrtc/offer/${taskId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: pc.localDescription.sdp,
          type: pc.localDescription.type,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || 'WebRTC 信令失败');
      }

      const answer = await resp.json();
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

      showToast('摄像头已连接 (WebRTC)，开始推流');
      updateCameraStatus('running', 'WebRTC 推流中...');
      document.getElementById('btnStartCamera').style.display = 'none';
      document.getElementById('btnStopCamera').style.display = '';

      _camWebRTCPC = pc;
      startCameraPolling();

      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') {
          showToast('WebRTC 连接失败', 'error');
        }
      });

    } catch (e) {
      console.error('WebRTC 连接失败:', e);
      showToast('WebRTC 连接失败: ' + e.message, 'error');
      disconnectCameraWebRTC();
    }
  }

  connect();
}

async function startCameraPipeline() {
  const input = getCameraInput();

  if (input === '__browser__') {
    await startBrowserCamera();
    return;
  }

  if (!input) { showToast('请输入摄像头地址', 'error'); return; }

  const btn = document.getElementById('btnStartCamera');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> 启动中...';

  try {
    let videoFilename;
    if (input === '0') {
      videoFilename = '__camera__0';
    } else if (input.startsWith('rtsp://') || input.startsWith('rtmp://') || input.startsWith('http://')) {
      videoFilename = input;
    } else {
      videoFilename = input;
    }

    const resp = await fetch(`${PIPE_API}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_filename: videoFilename,
        concurrent_mode: document.getElementById('camOptConcurrent').checked,
        ...collectCameraParams(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '启动失败');

    cameraTaskId = data.task_id;
    updateCameraStatus('running', '摄像头识别运行中...');
    document.getElementById('btnStartCamera').style.display = 'none';
    document.getElementById('btnStopCamera').style.display = '';
    showToast('摄像头 Pipeline 已启动');

    // WebRTC 接收处理后的视频流
    connectCameraWebRTC(cameraTaskId);

    startCameraPolling();
  } catch (e) {
    showToast('启动失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '▶ 启动摄像头识别';
  }
}

async function stopCameraPipeline() {
  const taskId = cameraTaskId;

  // 立即停止轮询，防止后续 pollCameraStatus 干扰新任务
  stopCameraPolling();
  cameraTaskId = null;

  // 断开摄像头 WebRTC 推流
  disconnectCameraWebRTC();

  // 停止浏览器摄像头采集
  if (browserCameraStream) {
    browserCameraStream.getTracks().forEach(t => t.stop());
    browserCameraStream = null;
  }
  const preview = document.getElementById('browserCameraPreview');
  if (preview) {
    preview.srcObject = null;
    preview.style.display = 'none';
  }
  const placeholder = document.getElementById('browserCameraPreviewPlaceholder');
  if (placeholder) placeholder.style.display = '';

  updateCameraStatus('idle', '正在停止...');
  resetCameraButtons();

  if (taskId) {
    try {
      await fetch(`${PIPE_API}/stop/${taskId}`, { method: 'POST' });
    } catch {}
  }

  const cameraStream = document.getElementById('cameraStream');
  const cameraPlaceholder = document.getElementById('cameraStreamPlaceholder');
  if (cameraStream) {
    cameraStream.pause();
    cameraStream.src = '';
    cameraStream.style.display = 'none';
  }
  if (cameraPlaceholder) cameraPlaceholder.style.display = '';

  showToast('摄像头已停止');
}

function startCameraPolling() {
  stopCameraPolling();
  cameraPollTimer = setInterval(pollCameraStatus, 3000);
}

function stopCameraPolling() {
  if (cameraPollTimer) {
    clearInterval(cameraPollTimer);
    cameraPollTimer = null;
  }
}

async function pollCameraStatus() {
  // 快照当前任务 ID，防止请求返回时 cameraTaskId 已变为新任务
  const taskId = cameraTaskId;
  if (!taskId) return;
  try {
    const resp = await fetch(`${PIPE_API}/status/${taskId}`);
    if (resp.status === 404) {
      if (cameraTaskId === taskId) {
        stopCameraPolling();
        resetCameraButtons();
        cameraTaskId = null;
      }
      return;
    }
    const data = await resp.json();
    updateCameraStatus(data.status, data.progress || data.error || '');

    if (data.status !== 'running') {
      if (cameraTaskId === taskId) {
        stopCameraPolling();
        resetCameraButtons();
        disconnectCameraWebRTC();
        if (data.status === 'completed') {
          showToast('✅ 摄像头处理完成');
        } else if (data.status === 'failed') {
          const errorMsg = data.error || '未知错误';
          if (errorMsg === '用户手动停止') {
            showToast('摄像头已停止', 'info');
          } else {
            showToast('摄像头处理失败: ' + errorMsg, 'error');
          }
        }
        cameraTaskId = null;
      }
    }
  } catch (e) {
    console.error('摄像头状态轮询失败:', e);
  }
}

function updateCameraStatus(status, text) {
  const dot = document.querySelector('#cameraStatus .status-dot');
  const statusText = document.getElementById('cameraStatusText');
  if (!dot || !statusText) return;
  dot.className = 'status-dot ' + (status === 'running' ? 'running' : status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'idle');
  statusText.textContent = text || status;
}

function resetCameraButtons() {
  const startBtn = document.getElementById('btnStartCamera');
  const stopBtn = document.getElementById('btnStopCamera');
  if (startBtn) startBtn.style.display = '';
  if (stopBtn) stopBtn.style.display = 'none';
}

// ── 摄像头 H.264 推流状态 ──
let _camH264Ws = null;
let _camH264MediaSource = null;
let _camH264SourceBuffer = null;
let _camH264Queue = [];

function connectCameraH264(taskId) {
  disconnectCameraH264();

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${location.host}${PIPE_API}/ws/h264/${taskId}`;

  const videoEl = document.getElementById('cameraStream');
  const placeholder = document.getElementById('cameraStreamPlaceholder');
  const fpsEl = document.getElementById('cameraStreamFps');
  if (!videoEl) return;

  // 显示 video，隐藏 placeholder
  videoEl.style.display = '';
  if (placeholder) placeholder.style.display = 'none';
  if (fpsEl) { fpsEl.style.display = ''; fpsEl.textContent = '连接中...'; }

  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  videoEl.load();  // 强制加载，确保 sourceopen 触发
  _camH264MediaSource = ms;
  _camH264SourceBuffer = null;
  _camH264Queue = [];

  ms.addEventListener('sourceopen', () => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    _camH264Ws = ws;

    let frameCount = 0;
    let fpsTimer = performance.now();

    function _processCamQueue() {
      const sb = _camH264SourceBuffer;
      if (!sb || sb.updating) return;
      try {
        const vEl = document.getElementById('cameraStream');
        if (vEl && sb.buffered.length > 0 && sb.buffered.start(0) < vEl.currentTime - 8) {
          sb.remove(sb.buffered.start(0), vEl.currentTime - 3);
          return;
        }
      } catch (e) {}
      if (_camH264Queue.length > 0) {
        try { sb.appendBuffer(_camH264Queue.shift()); } catch (e) {
          if (e.name === 'QuotaExceededError') {
            _camH264Queue.length = 0;
            try {
              const vEl = document.getElementById('cameraStream');
              if (vEl && sb.buffered.length > 0) sb.remove(sb.buffered.start(0), vEl.currentTime);
            } catch (e2) {}
          }
        }
      }
    }

    ws.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        const view = new DataView(evt.data);
        const msgType = view.getUint8(0);
        const payload = evt.data.slice(5);

        if (msgType === 0x01) {
          // Init segment（仅首次创建 SourceBuffer）
          if (_camH264SourceBuffer) {
            if (!_camH264SourceBuffer.updating) {
              try { _camH264SourceBuffer.appendBuffer(payload); } catch (e) {}
            }
            return;
          }
          try {
            if (ms.readyState !== 'open') {
              console.warn('摄像头 MediaSource 未就绪，忽略 init segment');
              return;
            }
            const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42C01F"');
            _camH264SourceBuffer = sb;
            sb.addEventListener('updateend', () => { _processCamQueue(); });
            sb.appendBuffer(payload);
          } catch (e) {
            console.error('摄像头 MSE SourceBuffer 创建失败:', e);
          }
        } else if (msgType === 0x02) {
          // Media segment
          const sb = _camH264SourceBuffer;
          if (!sb) return;
          if (sb.updating) {
            if (_camH264Queue.length >= 12) _camH264Queue = _camH264Queue.slice(-6);
            _camH264Queue.push(payload);
          } else {
            try { sb.appendBuffer(payload); } catch (e) {
              if (e.name === 'QuotaExceededError') {
                try {
                  const vEl = document.getElementById('cameraStream');
                  if (vEl && sb.buffered.length > 0) sb.remove(sb.buffered.start(0), vEl.currentTime - 2);
                } catch (e2) {}
                _camH264Queue.unshift(payload);
              }
            }
          }
          frameCount++;
          const now = performance.now();
          if (now - fpsTimer > 1000) {
            const fps = (frameCount * 1000 / (now - fpsTimer)).toFixed(1);
            if (fpsEl) fpsEl.textContent = `${fps} seg/s`;
            frameCount = 0;
            fpsTimer = now;
          }
        }
      } else {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'done') {
            disconnectCameraH264();
            if (fpsEl) fpsEl.textContent = '处理完成';
          }
        } catch {}
      }
    };

    ws.onclose = () => {
      if (cameraTaskId === taskId) {
        _scheduleReconnect('h264-cam', () => {
          if (cameraTaskId === taskId) connectCameraH264(taskId);
        }, taskId);
      }
    };
    ws.onerror = () => {};
  });
}

function disconnectCameraH264() {
  _clearReconnect('h264-cam');
  if (_camH264Ws) { _camH264Ws.onclose = null; _camH264Ws.close(); _camH264Ws = null; }
  if (_camH264MediaSource && _camH264MediaSource.readyState === 'open') {
    try { _camH264MediaSource.endOfStream(); } catch {}
  }
  _camH264MediaSource = null;
  _camH264SourceBuffer = null;
  _camH264Queue = [];
  const videoEl = document.getElementById('cameraStream');
  if (videoEl) { videoEl.pause(); videoEl.src = ''; }
  const fpsEl = document.getElementById('cameraStreamFps');
  if (fpsEl) fpsEl.textContent = '';
}

// ── WebSocket 自动重连（指数退避 + 状态检查 + 最大重试）──
const _reconnectStates = new Map(); // key → {delay, timer, retries}
const MAX_RECONNECT_RETRIES = 5;

async function _checkTaskRunning(taskId) {
  try {
    const resp = await fetch(`${PIPE_API}/status/${taskId}`);
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.status === 'running';
  } catch { return false; }
}

function _scheduleReconnect(key, connectFn, taskId) {
  let state = _reconnectStates.get(key);
  if (!state) {
    state = { delay: 1000, timer: null, retries: 0 };
    _reconnectStates.set(key, state);
  }
  if (state.timer) clearTimeout(state.timer);

  if (state.retries >= MAX_RECONNECT_RETRIES) {
    _reconnectStates.delete(key);
    return;
  }
  state.retries++;

  state.timer = setTimeout(async () => {
    // 重连前检查任务是否还在运行
    if (taskId) {
      const running = await _checkTaskRunning(taskId);
      if (!running) {
        _reconnectStates.delete(key);
        return;
      }
    }
    _reconnectStates.delete(key);
    connectFn();
  }, state.delay);
  state.delay = Math.min(state.delay * 2, 16000); // 1s → 2s → 4s → ... → 16s max
}

function _clearReconnect(key) {
  const state = _reconnectStates.get(key);
  if (state) {
    clearTimeout(state.timer);
    _reconnectStates.delete(key);
  }
}

// ── 工具函数 ──
if (typeof escHtml === 'undefined') {
  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
if (typeof escAttr === 'undefined') {
  function escAttr(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
  }
}

/** 安全地将文件名插入 HTML 属性（防 XSS） */
function safeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

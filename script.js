import * as Cloud from "./firebase-sync.js";

// pdf.js wor커 설정
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js";

let questionCount = 50;
let correctCountLive = 0;
let answeredCountLive = 0;
let currentQuestion = 1;
let studentAnswers = {};   // { 1: "3", 2: "1", ... }
let judged = {};           // { 1: true/false } - 채점 완료 여부
let wasCorrect = {};       // { 1: true/false }
let currentExamId = null;  // 지금 풀고 있는 문제지의 id
let currentMode = "free";  // "free" (자유문제 풀이) | "test" (시험방식 문제 풀이)
let testSubmitted = false; // 시험방식에서 제출(채점) 완료 여부
let maxReached = 1;        // 시험방식에서 지금까지 도달한 가장 뒤쪽 문항 번호

const examFileInput = document.getElementById("examFile");
const answerFileInput = document.getElementById("answerFile");
const questionCountInput = document.getElementById("questionCount");
const loadBtn = document.getElementById("loadBtn");
const loadStatus = document.getElementById("loadStatus");

/* 시험지 추가 팝업 */
const uploadModal = document.getElementById("uploadModal");
const openUploadBtn = document.getElementById("openUploadBtn");
const closeUploadBtn = document.getElementById("closeUploadBtn");

function openUploadModal() {
  loadStatus.textContent = "";
  uploadModal.classList.remove("hidden");
}
function closeUploadModal() {
  uploadModal.classList.add("hidden");
}
openUploadBtn.addEventListener("click", openUploadModal);
closeUploadBtn.addEventListener("click", closeUploadModal);
uploadModal.addEventListener("click", (e) => {
  if (e.target === uploadModal) closeUploadModal(); // 바깥(어두운 영역) 클릭 시 닫기
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !uploadModal.classList.contains("hidden")) closeUploadModal();
});
const keyStatus = document.getElementById("keyStatus");

const homeSection = document.getElementById("homeSection");
const solveSection = document.getElementById("solveSection");
const examListDiv = document.getElementById("examList");
const backToListBtn = document.getElementById("backToListBtn");

const keySection = document.getElementById("keySection");
const mainSection = document.getElementById("mainSection");

const examPagesDiv = document.getElementById("examPages");
const answerKeyTableDiv = document.getElementById("answerKeyTable");
const answerKeyPagesDiv = document.getElementById("answerKeyPages");
const navigatorDiv = document.getElementById("navigator");
const currentQLabel = document.getElementById("currentQLabel");
const feedbackDiv = document.getElementById("feedback");
const liveScoreDiv = document.getElementById("liveScore");
const keyScoreDiv = document.getElementById("keyScore");

const videoUrlInput = document.getElementById("videoUrlInput");
const videoSection = document.getElementById("videoSection");
const videoFrame = document.getElementById("videoFrame");

const fullscreenToggle = document.getElementById("fullscreenToggle");

const keyWrapper = document.getElementById("keyWrapper");
const revealKeyBtn = document.getElementById("revealKeyBtn");
const hideKeyBtn = document.getElementById("hideKeyBtn");

const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");

function showLoading(text) {
  loadingText.textContent = text || "불러오는 중...";
  loadingOverlay.classList.remove("hidden");
}

function hideLoading() {
  loadingOverlay.classList.add("hidden");
}

/* ---------------------------------------------------------
   클라우드 동기화 (로그인 + Firestore/Storage)
--------------------------------------------------------- */
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const accountEmail = document.getElementById("accountEmail");
const syncStatusEl = document.getElementById("syncStatus");

let cloudUser = null;
const cloudPushTimers = new Map();

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function setSyncStatus(state) {
  syncStatusEl.className = "sync-status " + state;
  syncStatusEl.title = {
    idle: "클라우드와 동기화됨",
    syncing: "동기화 중...",
    offline: "로그인하면 모든 기기에서 동기화돼요",
    error: "동기화 중 문제가 발생했어요 (연결을 확인해주세요)",
  }[state] || "";
}

signInBtn.addEventListener("click", async () => {
  try {
    setSyncStatus("syncing");
    await Cloud.signIn();
  } catch (e) {
    console.error(e);
    alert("로그인에 실패했습니다: " + e.message);
    setSyncStatus("offline");
  }
});

signOutBtn.addEventListener("click", async () => {
  await Cloud.signOutUser();
});

// 로컬에 저장하면서, 로그인되어 있으면 클라우드에도 올린다 (짧은 디바운스)
async function saveMetaAndSync(meta, { immediate = false } = {}) {
  meta.updatedAt = Date.now();
  await idbPutMeta(meta);
  if (!cloudUser) return;

  if (cloudPushTimers.has(meta.id)) clearTimeout(cloudPushTimers.get(meta.id));

  const doPush = async () => {
    cloudPushTimers.delete(meta.id);
    setSyncStatus("syncing");
    const ok = await Cloud.pushMeta(cloudUser.uid, meta.id, meta);
    setSyncStatus(ok ? "idle" : "error");
  };

  if (immediate) {
    await doPush();
  } else {
    cloudPushTimers.set(meta.id, setTimeout(doPush, 1200));
  }
}

// 로그인 직후: 로컬 ↔ 클라우드 데이터를 합친다 (최신 updatedAt이 이긴다)
async function performInitialSync() {
  if (!cloudUser) return;
  setSyncStatus("syncing");
  try {
    const remoteMetas = await Cloud.fetchAllRemoteMetas(cloudUser.uid);
    const localMetas = await idbGetAllMeta();
    const localById = new Map(localMetas.map((m) => [m.id, m]));

    for (const remoteMeta of remoteMetas) {
      const localMeta = localById.get(remoteMeta.id);
      if (!localMeta || (remoteMeta.updatedAt || 0) > (localMeta.updatedAt || 0)) {
        await idbPutMeta(remoteMeta); // 로컬에만 반영 (다시 올리지 않음)
        if (!(await idbGetBlob(remoteMeta.id))) {
          const blob = await Cloud.downloadBlob(cloudUser.uid, remoteMeta.id, "exam");
          if (blob) await idbPutBlob(remoteMeta.id, blob);
        }
        if (!(await idbGetBlob(remoteMeta.id + "_answer"))) {
          const answerBlob = await Cloud.downloadBlob(cloudUser.uid, remoteMeta.id, "answer");
          if (answerBlob) await idbPutBlob(remoteMeta.id + "_answer", answerBlob);
        }
      }
    }

    // 로컬에만 있고 아직 클라우드에 없는 문제지는 올린다
    const remoteIds = new Set(remoteMetas.map((m) => m.id));
    for (const localMeta of localMetas) {
      if (remoteIds.has(localMeta.id)) continue;
      await Cloud.pushMeta(cloudUser.uid, localMeta.id, localMeta);
      const examBlob = await idbGetBlob(localMeta.id);
      if (examBlob) await Cloud.uploadBlob(cloudUser.uid, localMeta.id, "exam", examBlob);
      const answerBlob = await idbGetBlob(localMeta.id + "_answer");
      if (answerBlob) await Cloud.uploadBlob(cloudUser.uid, localMeta.id, "answer", answerBlob);
    }

    if (homeSection.style.display !== "none") renderExamList();
    setSyncStatus("idle");
  } catch (e) {
    console.error("초기 동기화 실패", e);
    setSyncStatus("error");
  }
}

// 다른 기기에서 생긴 변경을 실시간으로 반영
function handleRemoteChange(change) {
  if (change.type === "removed") {
    idbDeleteMeta(change.examId);
    idbDeleteBlob(change.examId);
    idbDeleteBlob(change.examId + "_answer");
    if (currentExamId === change.examId) {
      alert("다른 기기에서 이 문제지를 삭제했습니다.");
      showHome();
    } else if (homeSection.style.display !== "none") {
      renderExamList();
    }
    return;
  }

  idbGetMeta(change.examId).then(async (localMeta) => {
    if (localMeta && (localMeta.updatedAt || 0) >= (change.meta.updatedAt || 0)) return;
    await idbPutMeta(change.meta);
    if (currentExamId === change.examId) {
      openExam(change.examId); // 지금 보고 있는 문제지가 바뀌었으면 새로 불러온다
    } else if (homeSection.style.display !== "none") {
      renderExamList();
    }
  });
}

Cloud.onAuthChange(async (user) => {
  cloudUser = user;
  if (user) {
    accountEmail.textContent = user.email || user.displayName || "";
    signInBtn.style.display = "none";
    signOutBtn.style.display = "inline-block";
    await performInitialSync();
    Cloud.subscribeRemoteChanges(user.uid, handleRemoteChange);
  } else {
    accountEmail.textContent = "";
    signInBtn.style.display = "inline-block";
    signOutBtn.style.display = "none";
    setSyncStatus("offline");
  }
});

const deleteExamBtn = document.getElementById("deleteExamBtn");
const resetProgressBtn = document.getElementById("resetProgressBtn");

const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomLevelLabel = document.getElementById("zoomLevelLabel");
let zoomLevel = 1;

/* 문제 위치 추적: 시험지 PDF의 글자 위치에서 "1." "2." 같은 문항 번호를 찾아 두고,
   문제를 넘길 때 그 위치로 스크롤한다 (글자가 들어있는 PDF에서만 동작) */
const examPagesScroll = document.getElementById("examPagesScroll");
const followBtn = document.getElementById("followBtn");
let questionMarkerCandidates = []; // PDF에서 찾은 "번호." 후보들
let questionPositions = null;      // 문항별 위치 [{page, x, y}] (페이지 안 비율), 못 찾으면 null
let followMode = localStorage.getItem("followMode") === "1";
let zoomBeforeFollow = 1;
let trackingRun = 0;      // 비동기 분석이 겹칠 때 최신 실행만 반영하기 위한 번호
let trackingBusy = false; // 화면 읽기(OCR) 분석 중 여부

const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const submitTestBtn = document.getElementById("submitTestBtn");

/* ---------------------------------------------------------
   저장 기능 (IndexedDB): 문제지를 여러 개 추가/보관/삭제
   - examsMeta: 문제 정보(제목, 문항수, 정답, 풀이기록) - 가볍고 자주 갱신됨
   - examBlobs: 문제지 PDF 원본(무거움) - 추가할 때 한 번만 저장
--------------------------------------------------------- */
const DB_NAME = "hanguksaExamDB";
const DB_VERSION = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("examsMeta")) {
        db.createObjectStore("examsMeta", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("examBlobs")) {
        db.createObjectStore("examBlobs");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutMeta(meta) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("examsMeta", "readwrite");
      tx.objectStore("examsMeta").put(meta);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { console.error("저장 실패", e); return false; }
}

async function idbGetMeta(id) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("examsMeta", "readonly");
      const req = tx.objectStore("examsMeta").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) { console.error(e); return null; }
}

async function idbGetAllMeta() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("examsMeta", "readonly");
      const req = tx.objectStore("examsMeta").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) { console.error(e); return []; }
}

async function idbDeleteMeta(id) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("examsMeta", "readwrite");
      tx.objectStore("examsMeta").delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { console.error(e); return false; }
}

async function idbPutBlob(id, blob) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("examBlobs", "readwrite");
      tx.objectStore("examBlobs").put(blob, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { console.error(e); return false; }
}

async function idbGetBlob(id) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("examBlobs", "readonly");
      const req = tx.objectStore("examBlobs").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) { console.error(e); return null; }
}

async function idbDeleteBlob(id) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("examBlobs", "readwrite");
      tx.objectStore("examBlobs").delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { console.error(e); return false; }
}

function makeExamId() {
  return (crypto.randomUUID ? crypto.randomUUID() : ("exam_" + Date.now() + "_" + Math.random().toString(16).slice(2)));
}

function getKeyAnswersFromDOM() {
  const arr = [];
  for (let i = 1; i <= questionCount; i++) {
    const el = document.getElementById("key" + i);
    arr.push(el ? el.value.trim() : "");
  }
  return arr;
}

function getKeyPointsFromDOM() {
  const arr = [];
  for (let i = 1; i <= questionCount; i++) {
    const el = document.getElementById("pt" + i);
    const p = el ? parseInt(el.value, 10) : NaN;
    arr.push(isNaN(p) ? "" : p);
  }
  return arr;
}

// 배점 합계: 맞힌 문항의 배점은 earned, 전체 배점은 total
function computeScore() {
  let earned = 0, total = 0, missing = 0, lost = 0;
  for (let i = 1; i <= questionCount; i++) {
    const el = document.getElementById("pt" + i);
    const p = el ? parseInt(el.value, 10) : NaN;
    if (isNaN(p)) { missing++; continue; }
    total += p;
    if (judged[i] && wasCorrect[i]) earned += p;
    else if (judged[i]) lost += p; // 채점했는데 틀린 문항의 배점
  }
  return { earned, total, missing, lost };
}

async function saveCurrentMeta() {
  if (!currentExamId) return;
  const meta = await idbGetMeta(currentExamId);
  if (!meta) return;
  meta.keyAnswers = getKeyAnswersFromDOM();
  meta.keyPoints = getKeyPointsFromDOM();
  meta.studentAnswers = studentAnswers;
  meta.judged = judged;
  meta.wasCorrect = wasCorrect;
  meta.mode = currentMode;
  meta.testSubmitted = testSubmitted;
  meta.maxReached = maxReached;
  await saveMetaAndSync(meta);
}

/* ---------------------------------------------------------
   홈 화면 (문제지 목록)
--------------------------------------------------------- */
/* 메인 메뉴 카드에 보여줄 점수 (저장된 풀이 기록 + 배점으로 계산) */
function computeMetaScore(meta) {
  const pts = meta.keyPoints || [];
  let earned = 0, total = 0;
  for (let i = 1; i <= (meta.questionCount || 0); i++) {
    const p = parseInt(pts[i - 1], 10);
    if (isNaN(p)) continue;
    total += p;
    if (meta.judged && meta.judged[i] && meta.wasCorrect && meta.wasCorrect[i]) earned += p;
  }
  return { earned, total };
}

/* ---------------------------------------------------------
   문제지 순서 바꾸기: 카드 윗부분을 길게 누른 채로 끌어서 옮긴다
--------------------------------------------------------- */
const REORDER_HOLD_MS = 450;  // 이 시간 이상 눌러야 시작
const REORDER_ZONE_PX = 64;   // 카드 위쪽 이 높이 안에서만 시작
let reorderDrag = null;
let justFinishedReorder = false;

// 끄는 동안에는 터치 화면이 스크롤되지 않게
document.addEventListener("touchmove", (e) => { if (reorderDrag) e.preventDefault(); }, { passive: false });

function setupCardReorder(card) {
  let timer = null, sx = 0, sy = 0;
  const cancelHold = () => { clearTimeout(timer); timer = null; };

  card.addEventListener("contextmenu", (e) => { if (timer || reorderDrag) e.preventDefault(); });

  card.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest("button") || reorderDrag) return;
    if (e.clientY - card.getBoundingClientRect().top > REORDER_ZONE_PX) return;
    sx = e.clientX;
    sy = e.clientY;
    const pid = e.pointerId;
    cancelHold();
    timer = setTimeout(() => { timer = null; startCardDrag(card, pid, sy); }, REORDER_HOLD_MS);
  });
  card.addEventListener("pointermove", (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancelHold(); // 움직이면 스크롤로 보고 취소
  });
  card.addEventListener("pointerup", cancelHold);
  card.addEventListener("pointercancel", cancelHold);
  card.addEventListener("pointerleave", () => { if (!reorderDrag) cancelHold(); });
}

function startCardDrag(card, pointerId, clientY) {
  const rect = card.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "exam-card-placeholder";
  placeholder.style.height = rect.height + "px";
  card.parentNode.insertBefore(placeholder, card);

  card.classList.add("dragging");
  card.style.width = rect.width + "px";
  card.style.left = rect.left + "px";
  card.style.top = rect.top + "px";
  document.body.classList.add("reordering");
  try { card.setPointerCapture(pointerId); } catch (e) { /* 무시 */ }
  if (navigator.vibrate) navigator.vibrate(15);

  reorderDrag = { card, placeholder, grab: clientY - rect.top, y: clientY, raf: 0 };
  card.addEventListener("pointermove", onCardDragMove);
  card.addEventListener("pointerup", endCardDrag);
  card.addEventListener("pointercancel", endCardDrag);
  reorderDrag.raf = requestAnimationFrame(cardDragLoop);
}

function onCardDragMove(e) {
  if (!reorderDrag) return;
  reorderDrag.y = e.clientY;
  reorderDrag.card.style.top = (e.clientY - reorderDrag.grab) + "px";
  updateCardPlaceholder();
}

// 끌고 있는 카드의 중심 위치에 맞춰 빈자리(placeholder)를 옮긴다
function updateCardPlaceholder() {
  const { card, placeholder } = reorderDrag;
  const r = card.getBoundingClientRect();
  const cy = r.top + r.height / 2;
  const others = [...examListDiv.querySelectorAll(".exam-card:not(.dragging)")];
  const target = others.find((el) => {
    const b = el.getBoundingClientRect();
    return b.top + b.height / 2 > cy;
  });
  if (target) {
    if (placeholder.nextElementSibling !== target) examListDiv.insertBefore(placeholder, target);
  } else if (examListDiv.lastElementChild !== placeholder) {
    examListDiv.appendChild(placeholder);
  }
}

// 화면 위/아래 끝으로 끌면 자동으로 스크롤
function cardDragLoop() {
  if (!reorderDrag) return;
  const margin = 90;
  let dy = 0;
  if (reorderDrag.y < margin) dy = -Math.ceil((margin - reorderDrag.y) / 6);
  else if (reorderDrag.y > window.innerHeight - margin) dy = Math.ceil((reorderDrag.y - (window.innerHeight - margin)) / 6);
  if (dy) {
    window.scrollBy(0, dy);
    updateCardPlaceholder();
  }
  reorderDrag.raf = requestAnimationFrame(cardDragLoop);
}

async function endCardDrag(e) {
  if (!reorderDrag) return;
  justFinishedReorder = true;
  setTimeout(() => { justFinishedReorder = false; }, 350);
  const { card, placeholder, raf } = reorderDrag;
  cancelAnimationFrame(raf);
  card.removeEventListener("pointermove", onCardDragMove);
  card.removeEventListener("pointerup", endCardDrag);
  card.removeEventListener("pointercancel", endCardDrag);
  try { card.releasePointerCapture(e.pointerId); } catch (err) { /* 무시 */ }

  examListDiv.insertBefore(card, placeholder);
  placeholder.remove();
  card.classList.remove("dragging");
  card.style.width = "";
  card.style.left = "";
  card.style.top = "";
  document.body.classList.remove("reordering");
  reorderDrag = null;

  await saveCardOrder();
}

// 화면에 보이는 순서대로 order 번호를 저장 (바뀐 문제지만 저장, 다른 기기에도 동기화)
async function saveCardOrder() {
  const ids = [...examListDiv.querySelectorAll(".exam-card")].map((c) => c.dataset.examId);
  for (let i = 0; i < ids.length; i++) {
    const meta = await idbGetMeta(ids[i]);
    if (meta && meta.order !== i) {
      meta.order = i;
      await saveMetaAndSync(meta);
    }
  }
}

async function renderExamList() {
  const metas = await idbGetAllMeta();
  // 직접 바꾼 순서(order)가 있으면 그대로, 순서가 없는 새 문제지는 맨 위에 최신순
  metas.sort((a, b) => {
    const ao = typeof a.order === "number";
    const bo = typeof b.order === "number";
    if (ao && bo) return a.order - b.order;
    if (ao !== bo) return ao ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  examListDiv.innerHTML = "";

  if (metas.length === 0) {
    const empty = document.createElement("div");
    empty.id = "examListEmpty";
    empty.textContent = "아직 추가된 문제지가 없습니다. 위에서 문제지를 추가해보세요.";
    examListDiv.appendChild(empty);
    return;
  }

  metas.forEach((meta) => {
    const card = document.createElement("div");
    card.className = "exam-card " + (meta.mode === "test" ? "mode-test" : "mode-free");
    card.dataset.examId = meta.id;

    const title = document.createElement("div");
    title.className = "exam-title";
    title.textContent = meta.title || "제목 없음";
    title.title = meta.title || "제목 없음"; // 길어서 ...로 잘려도 마우스를 올리면 전체 이름 표시

    const modeBadge = document.createElement("div");
    modeBadge.className = "exam-mode-badge";
    modeBadge.textContent = meta.mode === "test" ? "시험" : "자유";

    const answeredCount = Object.keys(meta.judged || {}).length;
    const correctCount = Object.keys(meta.judged || {}).filter(
      (k) => meta.wasCorrect && meta.wasCorrect[k]
    ).length;

    const meta_ = document.createElement("div");
    meta_.className = "exam-meta";
    const dateStr = meta.createdAt
      ? new Date(meta.createdAt).toLocaleString("ko-KR", {
          year: "numeric", month: "long", day: "numeric",
          hour: "2-digit", minute: "2-digit",
        })
      : "";
    let metaText = `${meta.questionCount}문항 · ${answeredCount}/${meta.questionCount} 풀이 · ${correctCount}개 정답`;
    // 점수: 자유문제는 푼 만큼, 시험방식은 제출한 뒤에만 표시
    const sc = computeMetaScore(meta);
    if (sc.total > 0 && (meta.mode !== "test" || meta.testSubmitted)) {
      metaText += ` · ${sc.earned}점 / ${sc.total}점`;
    }
    meta_.textContent = metaText;

    const dateEl = document.createElement("div");
    dateEl.className = "exam-date";
    dateEl.textContent = dateStr ? `만든 날짜: ${dateStr}` : "";

    const btnRow = document.createElement("div");
    btnRow.className = "exam-card-buttons";

    const delBtn = document.createElement("button");
    delBtn.className = "deleteExamCardBtn";
    delBtn.type = "button";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`"${meta.title}" 문제지를 삭제할까요? 되돌릴 수 없습니다.`)) return;
      await idbDeleteMeta(meta.id);
      await idbDeleteBlob(meta.id);
      await idbDeleteBlob(meta.id + "_answer");
      if (cloudUser) await Cloud.deleteRemoteExam(cloudUser.uid, meta.id);
      renderExamList();
    });

    const renameBtn = document.createElement("button");
    renameBtn.className = "renameExamBtn";
    renameBtn.type = "button";
    renameBtn.textContent = "이름 변경";
    renameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const input = prompt("시험지 이름을 입력하세요", meta.title || "");
      if (input === null) return;
      const newTitle = input.trim();
      if (!newTitle || newTitle === meta.title) return;
      const latest = await idbGetMeta(meta.id);
      if (!latest) return;
      latest.title = newTitle;
      await saveMetaAndSync(latest);
      renderExamList();
    });

    btnRow.appendChild(delBtn);

    const info = document.createElement("div");
    info.className = "exam-card-info";
    const titleRow = document.createElement("div");
    titleRow.className = "exam-title-row";
    titleRow.appendChild(title);
    titleRow.appendChild(modeBadge);
    info.appendChild(titleRow);
    info.appendChild(meta_);
    info.appendChild(dateEl);

    card.appendChild(info);
    card.appendChild(btnRow);
    card.appendChild(renameBtn); // 카드 오른쪽 상단
    // 카드(시험지 선택 칸)를 누르면 바로 입장
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `${meta.title || "제목 없음"} 풀기`);
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;   // 이름 변경 / 삭제 버튼은 제외
      if (justFinishedReorder) return;          // 순서를 바꾸고 손을 뗀 직후의 클릭은 무시
      openExam(meta.id);
    });
    card.addEventListener("keydown", (e) => {
      if (e.target !== card) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openExam(meta.id);
      }
    });

    setupCardReorder(card);
    examListDiv.appendChild(card);
  });
}

function showHome() {
  currentExamId = null;
  solveSection.style.display = "none";
  homeSection.style.display = "block";
  examFileInput.value = "";
  answerFileInput.value = "";
  videoUrlInput.value = "";
  videoFrame.src = "";
  videoSection.style.display = "none";
  loadStatus.textContent = "";
  renderExamList();
}

function showSolve() {
  homeSection.style.display = "none";
  solveSection.style.display = "block";
}

backToListBtn.addEventListener("click", showHome);

function updateModeUI() {
  const isLockedTest = currentMode === "test" && !testSubmitted;
  submitTestBtn.style.display = isLockedTest ? "block" : "none";
  keySection.classList.toggle("locked", isLockedTest);
  revealKeyBtn.disabled = isLockedTest;
}

/* ---------------------------------------------------------
   문제지 열기 (저장된 exam id로 복원)
--------------------------------------------------------- */
async function openExam(id) {
  const meta = await idbGetMeta(id);
  let blob = await idbGetBlob(id);
  if (!blob && cloudUser) {
    showLoading("클라우드에서 문제지를 받아오는 중...");
    try {
      blob = await withTimeout(
        Cloud.downloadBlob(cloudUser.uid, id, "exam", (cur, total) => {
          loadingText.textContent = `클라우드에서 문제지를 받아오는 중... (${cur}/${total})`;
        }),
        40000,
        "클라우드에서 문제지를 받아오는 데 시간이 너무 오래 걸려요. 네트워크 상태나 Firestore 보안 규칙을 확인해주세요."
      );
    } catch (e) {
      console.error("문제지 다운로드 실패", e);
      hideLoading();
      alert("문제지를 불러오지 못했습니다: " + e.message);
      return;
    }
    if (blob) await idbPutBlob(id, blob);
  }
  if (!meta || !blob) {
    hideLoading();
    alert(!meta
      ? "이 기기에 아직 이 문제지의 정보(메타데이터)가 동기화되지 않았습니다. 홈 화면으로 나갔다가 다시 들어와보세요."
      : "문제지를 불러올 수 없습니다.");
    return;
  }

  currentExamId = id;
  questionCount = meta.questionCount || 50;
  studentAnswers = meta.studentAnswers || {};
  judged = meta.judged || {};
  wasCorrect = meta.wasCorrect || {};
  currentMode = meta.mode || "free";
  testSubmitted = meta.testSubmitted || false;
  maxReached = meta.maxReached || 1;
  correctCountLive = 0;
  answeredCountLive = 0;

  showSolve();
  keySection.classList.remove("revealed");
  showLoading("문제지를 불러오는 중...");

  try {
    loadStatus.textContent = "";
    examPagesDiv.innerHTML = "";
    zoomLevel = 1;
    applyZoom();
    setAnnotateMode("off");
    await renderPDFToContainer(blob, examPagesDiv, 2.2);
    setupQuestionTracking(meta.questionPositions);
    applyAnnotations(meta.annotationStrokes);

    buildAnswerKeyTable(questionCount, meta.keyAnswers || new Array(questionCount).fill(""), meta.keyPoints || []);
    let pointsBackfilled = false;

    let answerBlob = await idbGetBlob(id + "_answer");
    if (!answerBlob && cloudUser) {
      try {
        answerBlob = await withTimeout(
          Cloud.downloadBlob(cloudUser.uid, id, "answer", (cur, total) => {
            loadingText.textContent = `클라우드에서 정답지를 받아오는 중... (${cur}/${total})`;
          }),
          40000,
          "정답지를 받아오는 데 시간이 너무 오래 걸려요."
        );
      } catch (e) {
        console.error("정답지 다운로드 실패(계속 진행)", e);
        answerBlob = null; // 정답지 없이도 문제지는 열 수 있게 계속 진행
      }
      if (answerBlob) await idbPutBlob(id + "_answer", answerBlob);
    }
    await renderAnswerKeyPDF(answerBlob, answerKeyPagesDiv, 1.6);

    // 배점 정보가 없던 예전 문제지: 저장된 정답지에서 배점만 다시 읽어 채운다
    if (!meta.keyPoints && answerBlob) {
      try {
        const r = await extractAnswerKey(answerBlob);
        r.points.forEach((p, idx) => {
          const el = document.getElementById("pt" + (idx + 1));
          if (el && p !== "") el.value = p;
        });
        pointsBackfilled = true;
      } catch (e) {
        console.error("배점 추출 실패", e);
      }
    }

    setupVideo(meta.videoId);

    buildNavigator(questionCount);

    const showGraded = currentMode === "free" || testSubmitted;
    for (let i = 1; i <= questionCount; i++) {
      const navBtn = document.getElementById("nav" + i);
      if (showGraded && judged[i]) {
        answeredCountLive++;
        if (wasCorrect[i]) correctCountLive++;
        if (navBtn) navBtn.classList.add(wasCorrect[i] ? "correct" : "wrong");
      } else if (!showGraded && studentAnswers[i]) {
        if (navBtn) navBtn.classList.add("answered");
      }
    }

    updateModeUI();
    setCurrentQuestion(1);
    updateLiveScore();
    if (pointsBackfilled) await saveCurrentMeta();
    keyStatus.textContent = testSubmitted || currentMode === "free"
      ? "정답이 저장되어 있습니다. '정답 보기'를 눌러 확인하거나 수정하세요."
      : "시험방식 풀이 중입니다. 모든 문제를 제출하면 정답을 확인할 수 있어요.";
  } catch (err) {
    console.error(err);
    alert("문제지를 불러오는 중 오류가 발생했습니다: " + err.message);
  } finally {
    hideLoading();
  }
}

/* ---------------------------------------------------------
   확대/축소
--------------------------------------------------------- */
function applyZoom() {
  examPagesDiv.style.width = (zoomLevel * 100) + "%";
  zoomLevelLabel.textContent = Math.round(zoomLevel * 100) + "%";
  zoomInBtn.disabled = zoomLevel >= 2.5;
  zoomOutBtn.disabled = zoomLevel <= 1;
  restartAnimation(zoomLevelLabel, "anim-pulse");
  if (followMode && questionPositions) scrollToQuestion(currentQuestion, false);
}

// 클래스를 지웠다가 다시 붙여서 CSS 애니메이션이 매번 재생되도록 강제한다
function restartAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // 강제 리플로우
  el.classList.add(className);
}

zoomInBtn.addEventListener("click", () => {
  zoomLevel = Math.min(2.5, Math.round((zoomLevel + 0.10) * 100) / 100);
  applyZoom();
});
zoomOutBtn.addEventListener("click", () => {
  zoomLevel = Math.max(1, Math.round((zoomLevel - 0.10) * 100) / 100);
  applyZoom();
});

// 한 페이지의 글자에서 문항 번호 후보("1." 등)와 그 위치를 모은다
async function collectQuestionMarkers(page, viewport, pageIndex) {
  const textContent = await page.getTextContent();
  const items = textContent.items.filter((it) => typeof it.str === "string");
  const found = [];

  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const t = it.str.trim();
    let num = null;
    const m = /^(\d{1,2})\s*[.．]$/.exec(t) || /^(\d{1,2})\s*[.．]\s+\S/.exec(t);
    if (m) {
      num = parseInt(m[1], 10);
    } else if (/^\d{1,2}$/.test(t)) {
      // "1" 과 "." 이 따로 나뉘어 있는 경우
      const next = items[k + 1];
      if (next && /^\s*[.．]/.test(next.str)) num = parseInt(t, 10);
    }
    if (num === null || num < 1 || num > 100) continue;

    // 글자 윗부분의 좌표를 화면 기준(왼쪽 위가 원점)으로 바꿔서 페이지 대비 비율로 저장
    const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5] + (it.height || 0));
    found.push({ num, page: pageIndex, x: vx / viewport.width, y: vy / viewport.height });
  }

  questionMarkerCandidates.push(...keepColumnAligned(found));
}

// 같은 세로줄(x)에 2개 이상 모여 있는 번호만 문항 번호로 인정 (본문 속 목록 번호 등을 걸러냄)
function keepColumnAligned(found) {
  const bucket = (x) => Math.round(x / 0.02);
  const counts = new Map();
  found.forEach((c) => counts.set(bucket(c.x), (counts.get(bucket(c.x)) || 0) + 1));
  const strong = new Set([...counts].filter(([, n]) => n >= 2).map(([b]) => b));
  return strong.size
    ? found.filter((c) => strong.has(bucket(c.x)) || strong.has(bucket(c.x) - 1) || strong.has(bucket(c.x) + 1))
    : found;
}

// 모은 후보에서 1번~N번 문항의 위치를 정한다
// 읽는 순서(페이지 → 왼쪽/오른쪽 단 → 위에서 아래)를 따라 번호가 커지도록 뒤에서부터 고른다.
// (표지의 유의사항 "1. 2. 3." 같은 앞쪽 가짜 후보를 피하기 위해)
function resolveQuestionPositions(n) {
  const order = (c) => [c.page, c.x > 0.5 ? 1 : 0, c.y];
  const cmp = (a, b) => {
    const A = order(a), B = order(b);
    for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
    return 0;
  };

  const result = new Array(n).fill(null);
  let upper = null;
  let foundCount = 0;
  for (let q = n; q >= 1; q--) {
    const pool = questionMarkerCandidates
      .filter((c) => c.num === q && (!upper || cmp(c, upper) < 0))
      .sort(cmp);
    if (pool.length) {
      const pick = pool[pool.length - 1];
      result[q - 1] = { page: pick.page, x: pick.x, y: pick.y };
      upper = pick;
      foundCount++;
    }
  }
  // 절반 이상 찾지 못하면 신뢰할 수 없으므로 기능을 끈다 (스캔본 PDF 등)
  return foundCount >= Math.max(3, Math.ceil(n * 0.5)) ? result : null;
}

function isValidPositions(arr, n) {
  return Array.isArray(arr) && arr.length === n && arr.filter(Boolean).length >= Math.max(3, Math.ceil(n * 0.5));
}

// 문항 위치를 확정하고, '따라가기'가 켜져 있으면 200%로 확대한다
function applyQuestionPositions(positions) {
  questionPositions = positions;
  if (followMode && questionPositions && solveSection.style.display !== "none") {
    zoomBeforeFollow = zoomLevel;
    zoomLevel = 2;
    applyZoom();
  }
  refreshFollowUI();
}

// 시험지를 그린 직후 호출
// 1) 저장해 둔 위치가 있으면 사용  2) PDF에 글자가 있으면 글자에서 찾기  3) 없으면(스캔본) 화면을 읽어서(OCR) 찾기
function setupQuestionTracking(cachedPositions) {
  trackingRun++;
  trackingBusy = false;
  if (isValidPositions(cachedPositions, questionCount)) {
    applyQuestionPositions(cachedPositions);
    return;
  }
  const fromText = resolveQuestionPositions(questionCount);
  applyQuestionPositions(fromText);
  if (!fromText) startOcrTracking(); // 오래 걸릴 수 있어 기다리지 않고 뒤에서 진행
}

function refreshFollowUI() {
  const ok = !!questionPositions;
  followBtn.disabled = trackingBusy || !ok;
  followBtn.classList.toggle("active", followMode && ok);
  if (trackingBusy) return;
  followBtn.textContent = "🎯 문제 따라가기";
  followBtn.title = ok
    ? "문제 따라가기: 켜면 200%로 확대하고, 문제를 넘길 때마다 그 문제 위치로 이동해요"
    : "이 시험지는 문제 위치를 찾지 못했어요";
}

// 현재 문제의 시작 위치가 시험지 영역의 왼쪽 위에 오도록 스크롤
function scrollToQuestion(i, smooth) {
  if (!followMode || !questionPositions) return;
  const pos = questionPositions[i - 1];
  if (!pos) return;
  const wrap = examPagesDiv.children[pos.page];
  if (!wrap) return;

  const scrollRect = examPagesScroll.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const top = examPagesScroll.scrollTop + (wrapRect.top - scrollRect.top) + pos.y * wrapRect.height - 28;
  const left = examPagesScroll.scrollLeft + (wrapRect.left - scrollRect.left) + pos.x * wrapRect.width - 24;
  examPagesScroll.scrollTo({
    top: Math.max(0, top),
    left: Math.max(0, left),
    behavior: smooth ? "smooth" : "auto",
  });
}

// ==OCR-BEGIN==
/* ---------------------------------------------------------
   스캔본(그림) PDF: 화면을 읽어서(OCR) 문항 번호 위치 찾기
   1) 각 줄의 '첫 단어' 영역을 잘라내고  2) 숫자만 읽도록 한 OCR로 읽어서  3) "12." 처럼 마침표가 붙은 것만 문항 번호로 인정
   (보기 ①②③은 마침표 없이 읽히므로 걸러진다)
--------------------------------------------------------- */
function detectMarkerCrops(img, W, H) {
  const px = img.data;
  const total = W * H;
  const dark = new Uint8Array(total);
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    dark[i] = px[p] * 0.3 + px[p + 1] * 0.59 + px[p + 2] * 0.11 < 140 ? 1 : 0;
  }

  // 긴 세로선(단 구분선, 테두리)은 지우고, 가운데 가까운 선을 두 단의 경계로 사용
  const colInk = new Int32Array(W);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) colInk[x] += dark[row + x];
  }
  let splitX = Math.round(W / 2);
  let bestDist = W * 0.12;
  for (let x = 0; x < W; x++) {
    if (colInk[x] > H * 0.5) {
      for (let y = 0; y < H; y++) dark[y * W + x] = 0;
      const d = Math.abs(x - W / 2);
      if (d < bestDist) { bestDist = d; splitX = x; }
    }
  }

  const ranges = [
    [Math.round(W * 0.02), splitX - 1],
    [splitX + 2, Math.round(W * 0.98)],
  ];
  const crops = [];

  for (const [xa, xb] of ranges) {
    if (xb <= xa) continue;

    // 줄(가로 띠) 찾기
    const rowInk = new Int32Array(H);
    for (let y = 0; y < H; y++) {
      let c = 0;
      const row = y * W;
      for (let x = xa; x <= xb; x++) c += dark[row + x];
      rowInk[y] = c;
    }
    const bands = [];
    let y = 0;
    while (y < H) {
      if (rowInk[y] >= 2) {
        const y0 = y;
        let last = y;
        while (y < H && (rowInk[y] >= 2 || y - last <= 2)) {
          if (rowInk[y] >= 2) last = y;
          y++;
        }
        bands.push([y0, last]);
      } else {
        y++;
      }
    }

    const heights = bands.map((b) => b[1] - b[0] + 1).filter((h) => h >= 8).sort((a, b) => a - b);
    if (!heights.length) continue;
    const med = heights[heights.length >> 1];

    for (const [y0, y1] of bands) {
      const h = y1 - y0 + 1;
      if (h < med * 0.5 || h > med * 2.4) continue;

      const colHasInk = (x) => {
        for (let yy = y0; yy <= y1; yy++) if (dark[yy * W + x]) return true;
        return false;
      };

      // 줄의 맨 왼쪽 글자 위치
      let xl = -1;
      for (let x = xa; x <= xb; x++) {
        if (colHasInk(x)) { xl = x; break; }
      }
      if (xl < 0) continue;

      // 첫 단어: 글자 사이 간격이 충분히 벌어지는 곳까지
      const gapMin = Math.max(3, Math.round(h * 0.33));
      const limit = Math.min(xb, xl + Math.round(h * 4));
      let xr = xl;
      let gap = 0;
      for (let x = xl; x <= limit; x++) {
        if (colHasInk(x)) { xr = x; gap = 0; }
        else if (++gap >= gapMin) break;
      }
      const w = xr - xl + 1;
      if (w < h * 0.4 || w > h * 3.4) continue;

      crops.push({
        x0: Math.max(0, xl - 3),
        x1: Math.min(W - 1, xr + 3),
        y0: Math.max(0, y0 - 2),
        y1: Math.min(H - 1, y1 + 2),
        xl,
        yTop: y0,
      });
      if (crops.length >= 200) return crops;
    }
  }
  return crops;
}

// 잘라낸 영역들을 한 장에 세로로 이어 붙인다 (OCR을 페이지당 1번만 돌리기 위해)
function buildCropStack(pageCanvas, crops) {
  const pad = 10;
  const gapY = 14;
  const items = crops.map((c) => {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    const f = Math.max(1, Math.min(2, 40 / h));
    return { c, w, h, dw: Math.round(w * f), dh: Math.round(h * f) };
  });
  const width = Math.max(...items.map((it) => it.dw)) + pad * 2;
  const height = items.reduce((sum, it) => sum + it.dh + gapY, pad);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  let y = pad;
  for (const it of items) {
    ctx.drawImage(pageCanvas, it.c.x0, it.c.y0, it.w, it.h, pad, y, it.dw, it.dh);
    it.top = y;
    it.bottom = y + it.dh;
    y += it.dh + gapY;
  }
  return { canvas, items };
}

function flattenOcrWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  (data.blocks || []).forEach((b) =>
    (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => (l.words || []).forEach((w) => out.push(w))))
  );
  return out;
}

// 이어 붙인 이미지의 OCR 결과에서, 각 영역의 첫 단어가 "숫자."이면 문항 번호 후보로 돌려준다
function parseMarkerWords(words, items, W, H, pageIndex) {
  const found = [];
  for (const it of items) {
    const inside = words.filter((w) => {
      const cy = (w.bbox.y0 + w.bbox.y1) / 2;
      return cy >= it.top - 4 && cy <= it.bottom + 4;
    });
    if (!inside.length) continue;
    inside.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const m = /^(\d{1,2})\./.exec((inside[0].text || "").trim());
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num < 1 || num > 100) continue;
    found.push({ num, page: pageIndex, x: it.c.xl / W, y: it.c.yTop / H });
  }
  return found;
}
// ==OCR-END==

let tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      el.onload = () => resolve(window.Tesseract);
      el.onerror = () => {
        tesseractPromise = null;
        reject(new Error("OCR 라이브러리를 불러오지 못했어요 (인터넷 연결 확인)"));
      };
      document.head.appendChild(el);
    });
  }
  return tesseractPromise;
}

// 시험지 페이지들을 읽어서 문항 번호 후보를 모은다
async function ocrQuestionMarkers(onProgress) {
  const Tesseract = await loadTesseract();
  const worker = await Tesseract.createWorker("eng");
  try {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789.",
      tessedit_pageseg_mode: "6",
    });
    const all = [];
    const pages = examPagesDiv.children;
    for (let p = 0; p < pages.length; p++) {
      if (onProgress) onProgress(p, pages.length);
      const pageCanvas = pages[p].querySelector("canvas");
      if (!pageCanvas) continue;
      const W = pageCanvas.width;
      const H = pageCanvas.height;
      const img = pageCanvas.getContext("2d").getImageData(0, 0, W, H);
      const crops = detectMarkerCrops(img, W, H);
      if (!crops.length) continue;
      const stack = buildCropStack(pageCanvas, crops);
      const { data } = await worker.recognize(stack.canvas);
      const found = parseMarkerWords(flattenOcrWords(data), stack.items, W, H, p);
      all.push(...keepColumnAligned(found));
    }
    return all;
  } finally {
    await worker.terminate();
  }
}

async function startOcrTracking() {
  const run = ++trackingRun;
  const examId = currentExamId;
  trackingBusy = true;
  followBtn.disabled = true;
  followBtn.textContent = "🎯 문제 위치 분석 중…";
  followBtn.title = "스캔본 PDF라서 화면을 읽어 문제 위치를 찾는 중이에요 (처음 한 번만, 1분 정도 걸릴 수 있어요)";

  let positions = null;
  try {
    const found = await ocrQuestionMarkers((done, total) => {
      if (run === trackingRun) followBtn.textContent = `🎯 문제 위치 분석 중 ${done + 1}/${total}`;
    });
    questionMarkerCandidates = found;
    positions = resolveQuestionPositions(questionCount);
    console.info(`문항 위치 인식(OCR): ${positions ? positions.filter(Boolean).length : 0}/${questionCount}문항`);
  } catch (e) {
    console.error("문항 위치 분석 실패", e);
  }

  // 다른 시험지를 열었거나 새로 분석이 시작됐다면 이 결과는 화면에 반영하지 않는다
  if (run !== trackingRun) return;
  trackingBusy = false;
  applyQuestionPositions(positions);

  // 다음에 다시 분석하지 않도록 시험지 정보에 저장 (다른 기기에도 동기화됨)
  if (positions && examId) {
    try {
      const meta = await idbGetMeta(examId);
      if (meta) {
        meta.questionPositions = positions;
        await saveMetaAndSync(meta);
      }
    } catch (e) {
      console.warn("문항 위치 저장 실패(무시)", e);
    }
  }
}

followBtn.addEventListener("click", () => {
  followMode = !followMode;
  localStorage.setItem("followMode", followMode ? "1" : "0");
  if (followMode) {
    zoomBeforeFollow = zoomLevel;
    zoomLevel = 2;
  } else {
    zoomLevel = zoomBeforeFollow || 1;
  }
  applyZoom(); // 켜져 있으면 현재 문제 위치로 함께 이동
  refreshFollowUI();
});

/* ---------------------------------------------------------
   필기 기능 (시험지 위에 손글씨로 표시)
--------------------------------------------------------- */
const penToolBtn = document.getElementById("penToolBtn");
const eraserToolBtn = document.getElementById("eraserToolBtn");
const clearAnnotationsBtn = document.getElementById("clearAnnotationsBtn");
const colorSwatchEls = document.querySelectorAll(".colorSwatch");
const colorPickerEl = document.getElementById("colorPicker");
const currentColorBtn = document.getElementById("currentColorBtn");
const currentColorDot = document.getElementById("currentColorDot");
const colorSwatchesEl = document.getElementById("colorSwatches");

function setColorPopover(open) {
  colorSwatchesEl.classList.toggle("hidden", !open);
  currentColorBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
currentColorBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setColorPopover(colorSwatchesEl.classList.contains("hidden"));
});
document.addEventListener("click", (e) => {
  if (!colorPickerEl.contains(e.target)) setColorPopover(false);
});
const undoAnnotationBtn = document.getElementById("undoAnnotationBtn");
const redoAnnotationBtn = document.getElementById("redoAnnotationBtn");

let annotateMode = "off"; // "off" | "pen" | "eraser"
let annotateColor = "#1c1c1e";

/* 필기 되돌리기 / 다시 되돌리기 기록 */
let annotationUndoStack = [];
let annotationRedoStack = [];

function updateUndoRedoButtons() {
  undoAnnotationBtn.disabled = annotationUndoStack.length === 0;
  redoAnnotationBtn.disabled = annotationRedoStack.length === 0;
}

function pushAnnotationHistory(action) {
  annotationUndoStack.push(action);
  annotationRedoStack = [];
  updateUndoRedoButtons();
}

function resetAnnotationHistory() {
  annotationUndoStack = [];
  annotationRedoStack = [];
  updateUndoRedoButtons();
}

function applyAnnotationActionReverse(action) {
  const pagesToRedraw = new Set();
  if (action.type === "draw") {
    const arr = pageStrokes[action.pageIndex];
    if (arr) {
      const idx = arr.lastIndexOf(action.stroke);
      if (idx !== -1) arr.splice(idx, 1);
    }
    pagesToRedraw.add(action.pageIndex);
  } else if (action.type === "erase") {
    for (let k = action.entries.length - 1; k >= 0; k--) {
      const e = action.entries[k];
      const arr = pageStrokes[e.pageIndex];
      if (arr) arr.splice(e.index, 0, e.stroke);
      pagesToRedraw.add(e.pageIndex);
    }
  } else if (action.type === "clear") {
    pageStrokes = action.prevStrokes.map((arr) => arr.slice());
    pageStrokes.forEach((_, i) => pagesToRedraw.add(i));
  }
  pagesToRedraw.forEach((i) => redrawPage(i));
}

function applyAnnotationActionForward(action) {
  const pagesToRedraw = new Set();
  if (action.type === "draw") {
    if (pageStrokes[action.pageIndex]) pageStrokes[action.pageIndex].push(action.stroke);
    pagesToRedraw.add(action.pageIndex);
  } else if (action.type === "erase") {
    for (let k = 0; k < action.entries.length; k++) {
      const e = action.entries[k];
      const arr = pageStrokes[e.pageIndex];
      if (arr) {
        const idx = arr.indexOf(e.stroke);
        if (idx !== -1) arr.splice(idx, 1);
      }
      pagesToRedraw.add(e.pageIndex);
    }
  } else if (action.type === "clear") {
    pageStrokes = pageStrokes.map(() => []);
    pageStrokes.forEach((_, i) => pagesToRedraw.add(i));
  }
  pagesToRedraw.forEach((i) => redrawPage(i));
}

async function undoAnnotationAction() {
  if (annotationUndoStack.length === 0) return;
  const action = annotationUndoStack.pop();
  applyAnnotationActionReverse(action);
  annotationRedoStack.push(action);
  updateUndoRedoButtons();
  await saveAnnotations();
}

async function redoAnnotationAction() {
  if (annotationRedoStack.length === 0) return;
  const action = annotationRedoStack.pop();
  applyAnnotationActionForward(action);
  annotationUndoStack.push(action);
  updateUndoRedoButtons();
  await saveAnnotations();
}

undoAnnotationBtn.addEventListener("click", undoAnnotationAction);
redoAnnotationBtn.addEventListener("click", redoAnnotationAction);

function setAnnotateMode(mode) {
  annotateMode = mode;
  penToolBtn.classList.toggle("active", mode === "pen");
  eraserToolBtn.classList.toggle("active", mode === "eraser");
  examPagesDiv.classList.toggle("annotating", mode !== "off");
}

penToolBtn.addEventListener("click", () => {
  setAnnotateMode(annotateMode === "pen" ? "off" : "pen");
});

eraserToolBtn.addEventListener("click", () => {
  setAnnotateMode(annotateMode === "eraser" ? "off" : "eraser");
});

colorSwatchEls.forEach((btn) => {
  btn.addEventListener("click", () => {
    annotateColor = btn.dataset.color;
    colorSwatchEls.forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    currentColorDot.style.background = annotateColor;
    setColorPopover(false);
    setAnnotateMode("pen");
  });
});

clearAnnotationsBtn.addEventListener("click", async () => {
  if (annotationCanvases.length === 0) return;
  if (!confirm("이 문제지의 모든 필기를 지울까요? 되돌리기 버튼으로 복구할 수 있어요.")) return;
  const prevStrokes = pageStrokes.map((arr) => arr.slice());
  pageStrokes = pageStrokes.map(() => []);
  annotationCanvases.forEach((c, i) => redrawPage(i));
  pushAnnotationHistory({ type: "clear", prevStrokes });
  await saveAnnotations();
});

function getCanvasPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

// 캔버스를 지우고 저장된 획(스트로크) 데이터를 다시 그린다
function redrawPage(pageIndex) {
  const canvas = annotationCanvases[pageIndex];
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  (pageStrokes[pageIndex] || []).forEach((stroke) => {
    if (!stroke.points || stroke.points.length === 0) return;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width || 3;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let p = 1; p < stroke.points.length; p++) {
      ctx.lineTo(stroke.points[p].x, stroke.points[p].y);
    }
    ctx.stroke();
  });
}

// 점 하나가 선분 a-b에 얼마나 가까운지 계산 (한 획 지우기용 히트 테스트)
function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function findStrokeAt(pageIndex, pos, threshold) {
  const strokes = pageStrokes[pageIndex] || [];
  for (let s = strokes.length - 1; s >= 0; s--) {
    const pts = strokes[s].points;
    if (pts.length === 1) {
      if (Math.hypot(pos.x - pts[0].x, pos.y - pts[0].y) <= threshold) return s;
      continue;
    }
    for (let k = 0; k < pts.length - 1; k++) {
      if (distToSegment(pos, pts[k], pts[k + 1]) <= threshold) return s;
    }
  }
  return -1;
}

const ERASE_THRESHOLD = 16;

function setupAnnotationCanvas(canvas, pageIndex) {
  let drawing = false;
  let currentStroke = null;
  let activeMode = null;      // 이번 드래그 시작 시점의 모드 ("pen" | "eraser")
  let currentErased = [];     // 이번 드래그에서 지운 획들 (되돌리기용)
  const ctx = canvas.getContext("2d");

  canvas.addEventListener("pointerdown", (e) => {
    if (annotateMode === "off") return;
    drawing = true;
    activeMode = annotateMode;
    currentErased = [];
    canvas.setPointerCapture(e.pointerId);
    const pos = getCanvasPos(e, canvas);

    if (annotateMode === "pen") {
      currentStroke = { color: annotateColor, width: 3, points: [pos] };
      pageStrokes[pageIndex].push(currentStroke);
      ctx.strokeStyle = annotateColor;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    } else if (annotateMode === "eraser") {
      const idx = findStrokeAt(pageIndex, pos, ERASE_THRESHOLD);
      if (idx !== -1) {
        const stroke = pageStrokes[pageIndex][idx];
        pageStrokes[pageIndex].splice(idx, 1);
        currentErased.push({ pageIndex, index: idx, stroke });
        redrawPage(pageIndex);
      }
    }
    e.preventDefault();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const pos = getCanvasPos(e, canvas);

    if (annotateMode === "pen" && currentStroke) {
      currentStroke.points.push(pos);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    } else if (annotateMode === "eraser") {
      const idx = findStrokeAt(pageIndex, pos, ERASE_THRESHOLD);
      if (idx !== -1) {
        const stroke = pageStrokes[pageIndex][idx];
        pageStrokes[pageIndex].splice(idx, 1);
        currentErased.push({ pageIndex, index: idx, stroke });
        redrawPage(pageIndex);
      }
    }
    e.preventDefault();
  });

  function stopDrawing() {
    if (!drawing) return;
    drawing = false;

    if (activeMode === "pen" && currentStroke) {
      pushAnnotationHistory({ type: "draw", pageIndex, stroke: currentStroke });
    } else if (activeMode === "eraser" && currentErased.length > 0) {
      pushAnnotationHistory({ type: "erase", entries: currentErased.slice() });
    }

    currentStroke = null;
    currentErased = [];
    activeMode = null;
    saveAnnotations();
  }
  canvas.addEventListener("pointerup", stopDrawing);
  canvas.addEventListener("pointerleave", stopDrawing);
  canvas.addEventListener("pointercancel", stopDrawing);
}

async function saveAnnotations() {
  if (!currentExamId) return;
  const meta = await idbGetMeta(currentExamId);
  if (!meta) return;
  meta.annotationStrokes = pageStrokes;
  await saveMetaAndSync(meta);
}

function applyAnnotations(savedStrokes) {
  pageStrokes = annotationCanvases.map((_, i) =>
    (savedStrokes && savedStrokes[i]) ? savedStrokes[i] : []
  );
  for (let i = 0; i < annotationCanvases.length; i++) redrawPage(i);
  resetAnnotationHistory();
}

/* ---------------------------------------------------------
   전체화면 (브라우저 전체화면, 탭 바가 보이지 않도록)
--------------------------------------------------------- */
function updateFullscreenLabel() {
  fullscreenToggle.textContent = document.fullscreenElement ? "전체화면 종료" : "전체화면";
}

fullscreenToggle.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.error("전체화면 전환 실패", err);
  }
});

document.addEventListener("fullscreenchange", updateFullscreenLabel);

/* ---------------------------------------------------------
   기출 영상 (유튜브)
--------------------------------------------------------- */
function extractYouTubeId(url) {
  if (!url) return null;
  const match = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function setupVideo(videoId) {
  if (videoId) {
    videoFrame.src = `https://www.youtube.com/embed/${videoId}`;
    videoSection.style.display = "block";
  } else {
    videoFrame.src = "";
    videoSection.style.display = "none";
  }
}

/* ---------------------------------------------------------
   정답 확인 표 가림/보기
--------------------------------------------------------- */
revealKeyBtn.addEventListener("click", () => {
  keySection.classList.add("revealed");
});

hideKeyBtn.addEventListener("click", () => {
  keySection.classList.remove("revealed");
});

/* ---------------------------------------------------------
   이 문제지 삭제 / 푼 문제 초기화 (풀이 화면 안에서)
--------------------------------------------------------- */
deleteExamBtn.addEventListener("click", async () => {
  if (!currentExamId) return;
  if (!confirm("이 문제지와 정답, 풀이 기록을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;

  await idbDeleteMeta(currentExamId);
  await idbDeleteBlob(currentExamId);
  await idbDeleteBlob(currentExamId + "_answer");
  if (cloudUser) await Cloud.deleteRemoteExam(cloudUser.uid, currentExamId);
  showHome();
});

resetProgressBtn.addEventListener("click", async () => {
  if (!confirm("지금까지 푼 답을 모두 지우고 다시 풀까요? 문제지와 정답은 유지됩니다.")) return;

  studentAnswers = {};
  judged = {};
  wasCorrect = {};
  correctCountLive = 0;
  answeredCountLive = 0;
  testSubmitted = false;
  maxReached = 1;

  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("correct", "wrong", "answered", "locked"));
  keySection.classList.remove("revealed");
  updateModeUI();
  setCurrentQuestion(1);
  updateLiveScore();
  await saveCurrentMeta();
});

/* ---------------------------------------------------------
   문제지 추가하기
--------------------------------------------------------- */
loadBtn.addEventListener("click", async () => {
  const examFile = examFileInput.files[0];
  const answerFile = answerFileInput.files[0];
  questionCount = parseInt(questionCountInput.value, 10) || 50;

  if (!examFile) {
    loadStatus.textContent = "문제지 PDF를 선택해주세요.";
    return;
  }

  const id = makeExamId();
  const title = examFile.name.replace(/\.pdf$/i, "");
  const modeInput = document.querySelector('input[name="examMode"]:checked');

  currentExamId = id;
  currentMode = modeInput ? modeInput.value : "free";
  testSubmitted = false;
  maxReached = 1;
  correctCountLive = 0;
  answeredCountLive = 0;
  currentQuestion = 1;
  studentAnswers = {};
  judged = {};
  wasCorrect = {};

  try {
    loadStatus.textContent = "";
    showSolve();
    keySection.classList.remove("revealed");
    showLoading("문제지를 만드는 중...");
    examPagesDiv.innerHTML = "";
    zoomLevel = 1;
    applyZoom();
    setAnnotateMode("off");
    await renderPDFToContainer(examFile, examPagesDiv, 2.2);
    setupQuestionTracking();

    if (examPagesDiv.childElementCount === 0) {
      loadStatus.textContent = "문제지 PDF에서 페이지를 찾지 못했습니다. 파일이 올바른지 확인해주세요.";
      showHome();
      return;
    }

    let extracted = new Array(questionCount).fill("");
    let extractedPoints = new Array(questionCount).fill("");
    if (answerFile) {
      loadingText.textContent = "정답지를 분석하는 중...";
      const result = await extractAnswerKey(answerFile);
      extracted = result.answers;
      extractedPoints = result.points;
      await renderAnswerKeyPDF(answerFile, answerKeyPagesDiv, 1.6);
      const ptsFound = extractedPoints.filter((p) => p !== "").length;
      keyStatus.textContent = `정답이 자동으로 입력되었습니다 (배점 ${ptsFound}/${questionCount}문항 인식). '정답 보기'를 눌러 확인하고, 틀린 항목은 직접 수정하세요.`;
    } else {
      answerKeyPagesDiv.innerHTML = "";
      keyStatus.textContent = "정답지가 없습니다. '정답 보기'를 눌러 정답을 직접 입력하세요.";
    }

    const videoId = extractYouTubeId(videoUrlInput.value.trim());
    setupVideo(videoId);

    buildAnswerKeyTable(questionCount, extracted, extractedPoints);
    buildNavigator(questionCount);
    updateModeUI();
    setCurrentQuestion(1);
    updateLiveScore();

    // 저장: 이 문제지는 목록에서 삭제하기 전까지 계속 유지된다
    await idbPutBlob(id, examFile);
    if (answerFile) await idbPutBlob(id + "_answer", answerFile);
    await saveMetaAndSync(
      {
        id,
        title,
        questionCount,
        keyAnswers: extracted,
        keyPoints: extractedPoints,
        studentAnswers: {},
        judged: {},
        wasCorrect: {},
        mode: currentMode,
        testSubmitted: false,
        maxReached: 1,
        annotationStrokes: [],
        videoId: videoId || null,
        createdAt: Date.now(),
      },
      { immediate: true }
    );

    if (cloudUser) {
      try {
        await withTimeout(
          Cloud.uploadBlob(cloudUser.uid, id, "exam", examFile, (cur, total) => {
            loadingText.textContent = `클라우드에 업로드하는 중... (${cur}/${total})`;
          }),
          60000,
          "클라우드 업로드가 너무 오래 걸려요."
        );
        if (answerFile) {
          await withTimeout(
            Cloud.uploadBlob(cloudUser.uid, id, "answer", answerFile, (cur, total) => {
              loadingText.textContent = `클라우드에 정답지 업로드하는 중... (${cur}/${total})`;
            }),
            60000,
            "정답지 클라우드 업로드가 너무 오래 걸려요."
          );
        }
      } catch (e) {
        console.error("클라우드 업로드 실패(로컬에는 저장됨)", e);
        // 클라우드 업로드가 실패해도 로컬 저장은 이미 끝났으므로 문제지 사용 자체는 계속 진행한다
      }
    }

    videoUrlInput.value = "";
    loadStatus.textContent = "";
    closeUploadModal();
  } catch (err) {
    console.error(err);
    loadStatus.textContent = "불러오는 중 오류가 발생했습니다: " + err.message;
    showHome();
  } finally {
    hideLoading();
  }
});

// PDF를 페이지별 캔버스로 렌더링 (각 페이지 위에 필기용 캔버스를 겹쳐서 만든다)
let annotationCanvases = [];
let pageStrokes = [];

async function renderPDFToContainer(file, container, scale) {
  container.innerHTML = "";
  annotationCanvases = [];
  pageStrokes = [];
  questionMarkerCandidates = [];
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: scale });

    const wrap = document.createElement("div");
    wrap.className = "examPageWrap";

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("캔버스를 생성할 수 없습니다 (2d context 없음)");
    }
    await page.render({ canvasContext: context, viewport: viewport }).promise;

    const annCanvas = document.createElement("canvas");
    annCanvas.className = "annotation-canvas";
    annCanvas.width = viewport.width;
    annCanvas.height = viewport.height;
    const pageIndex = annotationCanvases.length;
    pageStrokes.push([]);
    setupAnnotationCanvas(annCanvas, pageIndex);

    wrap.appendChild(canvas);
    wrap.appendChild(annCanvas);
    container.appendChild(wrap);
    annotationCanvases.push(annCanvas);

    try {
      await collectQuestionMarkers(page, viewport, pageNum - 1);
    } catch (e) {
      console.warn("문항 위치 분석 실패(무시)", e);
    }
  }
}

// 정답지(답지) PDF를 단순 이미지로 렌더링 (필기 기능 없이 보기 전용)
async function renderAnswerKeyPDF(blob, container, scale) {
  container.innerHTML = "";
  if (!blob) return;
  const arrayBuffer = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: scale });
    const canvas = document.createElement("canvas");
    canvas.className = "answerKeyPageCanvas";
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    container.appendChild(canvas);
  }
}

// 정답지 PDF에서 정답 + 배점 자동 추출 -> { answers: [...], points: [...] }
async function extractAnswerKey(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let fullText = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    fullText += " " + textContent.items.map((item) => item.str).join(" ");
  }

  const circledMap = { "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5" };
  const emptyPoints = () => new Array(questionCount).fill("");

  // 전략 1 (우선): "문항번호 + 정답(원문자) + 배점" 패턴 (예: "1 ③ 2", "11 ⑤ 3").
  // 정답은 원문자로만 표기되므로 번호와 정답을 짝지을 수 있고,
  // 정답 바로 오른쪽의 한 자리 숫자를 배점으로 읽는다.
  // (바로 뒤 숫자가 다음 문항 번호인 경우 - 즉 그 뒤에 원문자가 이어지면 - 배점으로 보지 않는다.)
  const pattern = /(\d{1,2})\s*[.)]?\s*([①②③④⑤])(?:\s*(\d)(?!\d)(?!\s*[.)]?\s*[①②③④⑤]))?/g;
  const found = {};
  const foundPts = {};
  let match;
  while ((match = pattern.exec(fullText)) !== null) {
    const qNum = parseInt(match[1], 10);
    if (qNum >= 1 && qNum <= questionCount && !found[qNum]) {
      found[qNum] = circledMap[match[2]];
      if (match[3]) {
        const pts = parseInt(match[3], 10);
        if (pts >= 1 && pts <= 5) foundPts[qNum] = pts;
      }
    }
  }
  if (Object.keys(found).length >= questionCount * 0.8) {
    const answers = [];
    const points = [];
    for (let i = 1; i <= questionCount; i++) {
      answers.push(found[i] || "");
      points.push(foundPts[i] !== undefined ? foundPts[i] : "");
    }
    return { answers, points };
  }

  // 전략 2 (보조): 원문자가 문항 수 이상 등장하면 등장 순서를 1번~N번으로 가정한다. (배점은 알 수 없음)
  const circledMatches = fullText.match(/[①②③④⑤]/g) || [];
  if (circledMatches.length >= questionCount) {
    return { answers: circledMatches.slice(0, questionCount).map((c) => circledMap[c]), points: emptyPoints() };
  }

  // 전략 3: 실패 시 빈 값 (수동 입력)
  return { answers: new Array(questionCount).fill(""), points: emptyPoints() };
}

// 정답 입력 표 (자동 추출 결과로 채워짐, 수정 가능)
function buildAnswerKeyTable(n, answers, points) {
  points = points || [];
  answerKeyTableDiv.innerHTML = "";
  for (let i = 1; i <= n; i++) {
    const cell = document.createElement("div");
    cell.className = "key-cell";

    const label = document.createElement("span");
    label.textContent = i + "번";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 1;
    input.id = "key" + i;
    input.value = answers[i - 1] || "";
    input.addEventListener("change", () => {
      if (judged[i]) checkAnswer(i, studentAnswers[i]);
      saveCurrentMeta();
    });

    // 배점 입력 (정답지에서 자동 인식, 수정 가능)
    const ptInput = document.createElement("input");
    ptInput.type = "text";
    ptInput.inputMode = "numeric";
    ptInput.maxLength = 2;
    ptInput.className = "pt-input";
    ptInput.id = "pt" + i;
    ptInput.placeholder = "배점";
    ptInput.title = i + "번 배점";
    ptInput.value = points[i - 1] === undefined || points[i - 1] === "" ? "" : points[i - 1];
    ptInput.addEventListener("change", () => {
      updateLiveScore();
      saveCurrentMeta();
    });

    cell.appendChild(label);
    cell.appendChild(input);
    cell.appendChild(ptInput);
    answerKeyTableDiv.appendChild(cell);
  }
}

// 문항 네비게이터 (클릭해서 해당 문항으로 이동)
function buildNavigator(n) {
  navigatorDiv.innerHTML = "";
  for (let i = 1; i <= n; i++) {
    const btn = document.createElement("button");
    btn.className = "nav-btn";
    btn.id = "nav" + i;
    btn.textContent = i;
    btn.addEventListener("click", () => {
      if (currentMode === "test" && !testSubmitted && i > maxReached) {
        restartAnimation(btn, "anim-pulse");
        return;
      }
      setCurrentQuestion(i);
    });
    navigatorDiv.appendChild(btn);
  }
}

function setCurrentQuestion(i) {
  currentQuestion = i;
  if (currentMode === "test" && !testSubmitted && i > maxReached) {
    maxReached = i;
    saveCurrentMeta();
  }
  currentQLabel.textContent = i + "번 문항의 답을 선택하세요";
  restartAnimation(currentQLabel, "anim-fade");
  feedbackDiv.textContent = "";
  feedbackDiv.className = "";

  const isLockedTest = currentMode === "test" && !testSubmitted;
  document.querySelectorAll(".nav-btn").forEach((b, idx) => {
    b.classList.remove("current");
    if (isLockedTest) {
      b.classList.toggle("locked", (idx + 1) > maxReached);
    } else {
      b.classList.remove("locked");
    }
  });
  const navBtn = document.getElementById("nav" + i);
  if (navBtn) navBtn.classList.add("current");

  document.querySelectorAll(".choiceBtn").forEach((b) => {
    b.classList.toggle("selected", studentAnswers[i] === b.dataset.choice);
  });

  prevBtn.disabled = i <= 1;
  nextBtn.disabled = i >= questionCount;

  if ((currentMode === "free" || testSubmitted) && judged[i]) {
    showFeedback(i);
  }

  scrollToQuestion(i, true); // '문제 따라가기'가 켜져 있으면 이 문제 위치로 이동
}

// 큰 버튼 클릭 시 답 선택
document.querySelectorAll(".choiceBtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectAnswer(btn.dataset.choice);
  });
});

// 키보드: 1~5 = 답 선택, ← → = 이전/다음 문제 (입력칸에 글자를 입력 중일 때는 동작하지 않음)
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

document.addEventListener("keydown", (e) => {
  if (solveSection.style.display === "none") return;
  if (!uploadModal.classList.contains("hidden")) return;
  if (isTypingTarget(e.target)) return;

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoAnnotationAction();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
    e.preventDefault();
    redoAnnotationAction();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // 윗줄 숫자키(Digit1~5)와 숫자패드(Numpad1~5) 모두 지원
  const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code || "");
  const digit = m ? m[1] : (["1", "2", "3", "4", "5"].includes(e.key) ? e.key : null);
  if (digit) {
    e.preventDefault();
    selectAnswer(digit);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (currentQuestion < questionCount) setCurrentQuestion(currentQuestion + 1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (currentQuestion > 1) setCurrentQuestion(currentQuestion - 1);
  }
});

// 이전/다음 문제 버튼: 정답 선택 후 자동으로 넘어가지 않고, 직접 눌러야 이동
prevBtn.addEventListener("click", () => {
  if (currentQuestion > 1) setCurrentQuestion(currentQuestion - 1);
});
nextBtn.addEventListener("click", () => {
  if (currentQuestion < questionCount) setCurrentQuestion(currentQuestion + 1);
});

// 답을 선택하면 즉시 채점 결과만 보여주고, 다음 문제로는 넘어가지 않는다
// (시험방식이고 아직 제출 전이면 정답 여부는 보여주지 않고 선택만 기록한다)
function selectAnswer(choice) {
  const i = currentQuestion;
  studentAnswers[i] = choice;
  document.querySelectorAll(".choiceBtn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.choice === choice);
  });

  if (currentMode === "test" && !testSubmitted) {
    const navBtn = document.getElementById("nav" + i);
    if (navBtn) navBtn.classList.add("answered");
    updateLiveScore();
    saveCurrentMeta();
  } else {
    checkAnswer(i, choice);
  }
}

function checkAnswer(i, studentAnswer) {
  const keyInput = document.getElementById("key" + i);
  const correctAnswer = keyInput.value.trim();

  const wasJudgedBefore = judged[i] === true;
  const wasCorrectBefore = wasCorrect[i] === true;

  const isCorrect = correctAnswer && studentAnswer === correctAnswer;

  if (wasJudgedBefore && wasCorrectBefore && !isCorrect) correctCountLive--;
  if ((!wasJudgedBefore || !wasCorrectBefore) && isCorrect) correctCountLive++;
  if (!wasJudgedBefore) answeredCountLive++;

  judged[i] = true;
  wasCorrect[i] = isCorrect;

  const navBtn = document.getElementById("nav" + i);
  navBtn.classList.remove("correct", "wrong");
  void navBtn.offsetWidth;
  navBtn.classList.add(isCorrect ? "correct" : "wrong");

  if (i === currentQuestion) showFeedback(i);
  updateLiveScore();
  saveCurrentMeta();
}

function showFeedback(i) {
  const correctAnswer = document.getElementById("key" + i).value.trim();
  feedbackDiv.textContent = "";
  feedbackDiv.className = "";
  void feedbackDiv.offsetWidth;
  if (wasCorrect[i]) {
    feedbackDiv.textContent = "정답입니다! ✅";
    feedbackDiv.className = "correct";
  } else {
    feedbackDiv.textContent = "오답입니다 ❌ (정답: " + (correctAnswer || "미입력") + ")";
    feedbackDiv.className = "wrong";
  }
}

function updateLiveScore() {
  if (currentMode === "test" && !testSubmitted) {
    const answered = Object.keys(studentAnswers).length;
    liveScoreDiv.textContent = `풀이 진행: ${answered} / ${questionCount}문항 (제출 전에는 정답이 표시되지 않아요)`;
  } else {
    liveScoreDiv.textContent = `맞은 개수: ${correctCountLive} / ${answeredCountLive} (전체 ${questionCount}문항 중 ${answeredCountLive}문항 풀이)`;
  }
  updateKeyScore();
}

// 답 선택 패널 안 점수 표시
// 자유문제: 푸는 즉시 점수가 쌓인다 / 시험방식: 제출 후 최종 점수를 보여준다
function updateKeyScore() {
  if (!keyScoreDiv) return;
  if (currentMode === "test" && !testSubmitted) {
    // 시험방식은 제출 전에는 점수를 보여주지 않는다
    keyScoreDiv.className = "";
    keyScoreDiv.textContent = "";
    return;
  }
  const { earned, total, missing, lost } = computeScore();
  if (total === 0) {
    keyScoreDiv.className = "muted";
    keyScoreDiv.textContent = "배점 정보가 없어요. 정답표의 '배점' 칸에 입력하면 점수가 계산돼요";
    return;
  }
  keyScoreDiv.className = "";
  const label = currentMode === "test" ? "최종 점수" : "현재 점수";
  keyScoreDiv.textContent = `${label}: ${earned}점 / ${total}점` + (missing ? ` (배점 미입력 ${missing}문항 제외)` : "");
  // 현재까지 틀린 문제의 점수를 작게 함께 표시
  const wrongEl = document.createElement("span");
  wrongEl.className = "wrong-score";
  wrongEl.textContent = `틀린 점수 ${lost}점`;
  keyScoreDiv.appendChild(wrongEl);
}

// 시험방식: 제출하면 그동안 고른 답을 한 번에 채점한다
async function finishTest() {
  if (!confirm("제출하면 모든 문항이 채점됩니다. 계속할까요?")) return;

  testSubmitted = true;
  correctCountLive = 0;
  answeredCountLive = 0;

  for (let i = 1; i <= questionCount; i++) {
    const ans = studentAnswers[i] || "";
    const navBtn = document.getElementById("nav" + i);
    navBtn.classList.remove("answered", "locked");

    if (!ans) {
      judged[i] = false;
      continue;
    }
    const correctAnswer = document.getElementById("key" + i).value.trim();
    const isCorrect = correctAnswer && ans === correctAnswer;
    judged[i] = true;
    wasCorrect[i] = isCorrect;
    answeredCountLive++;
    if (isCorrect) correctCountLive++;
    navBtn.classList.add(isCorrect ? "correct" : "wrong");
  }

  updateModeUI();
  updateLiveScore();
  if (judged[currentQuestion]) showFeedback(currentQuestion);
  await saveCurrentMeta();

  const sc = computeScore();
  const scoreText = sc.total > 0 ? ` 최종 점수는 ${sc.earned}점 / ${sc.total}점이에요.` : "";
  alert(`채점 완료! ${questionCount}문항 중 ${correctCountLive}개 정답입니다.${scoreText} 이제 문항을 자유롭게 오가며 정답을 확인할 수 있어요.`);
}

submitTestBtn.addEventListener("click", finishTest);

/* ---------------------------------------------------------
   시작: 홈 화면(문제지 목록)부터 보여준다
--------------------------------------------------------- */
showHome();
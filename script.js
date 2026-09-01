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
const keyStatus = document.getElementById("keyStatus");

const homeSection = document.getElementById("homeSection");
const solveSection = document.getElementById("solveSection");
const examListDiv = document.getElementById("examList");
const backToListBtn = document.getElementById("backToListBtn");

const keySection = document.getElementById("keySection");
const mainSection = document.getElementById("mainSection");

const examPagesDiv = document.getElementById("examPages");
const answerKeyTableDiv = document.getElementById("answerKeyTable");
const navigatorDiv = document.getElementById("navigator");
const currentQLabel = document.getElementById("currentQLabel");
const feedbackDiv = document.getElementById("feedback");
const liveScoreDiv = document.getElementById("liveScore");

const themeToggle = document.getElementById("themeToggle");
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

const deleteExamBtn = document.getElementById("deleteExamBtn");
const resetProgressBtn = document.getElementById("resetProgressBtn");

const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomLevelLabel = document.getElementById("zoomLevelLabel");
let zoomLevel = 1;

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

async function saveCurrentMeta() {
  if (!currentExamId) return;
  const meta = await idbGetMeta(currentExamId);
  if (!meta) return;
  meta.keyAnswers = getKeyAnswersFromDOM();
  meta.studentAnswers = studentAnswers;
  meta.judged = judged;
  meta.wasCorrect = wasCorrect;
  meta.mode = currentMode;
  meta.testSubmitted = testSubmitted;
  meta.maxReached = maxReached;
  await idbPutMeta(meta);
}

/* ---------------------------------------------------------
   홈 화면 (문제지 목록)
--------------------------------------------------------- */
async function renderExamList() {
  const metas = await idbGetAllMeta();
  metas.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

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
    card.className = "exam-card";

    const title = document.createElement("div");
    title.className = "exam-title";
    title.textContent = meta.title || "제목 없음";

    const modeBadge = document.createElement("div");
    modeBadge.className = "exam-mode-badge";
    modeBadge.textContent = meta.mode === "test" ? "시험방식" : "자유문제";

    const answeredCount = Object.keys(meta.judged || {}).length;
    const correctCount = Object.keys(meta.judged || {}).filter(
      (k) => meta.wasCorrect && meta.wasCorrect[k]
    ).length;

    const meta_ = document.createElement("div");
    meta_.className = "exam-meta";
    meta_.textContent = `${meta.questionCount}문항 · ${answeredCount}/${meta.questionCount} 풀이 · ${correctCount}개 정답`;

    const btnRow = document.createElement("div");
    btnRow.className = "exam-card-buttons";

    const openBtn = document.createElement("button");
    openBtn.className = "openExamBtn";
    openBtn.type = "button";
    openBtn.textContent = "풀기";
    openBtn.addEventListener("click", () => openExam(meta.id));

    const delBtn = document.createElement("button");
    delBtn.className = "deleteExamCardBtn";
    delBtn.type = "button";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`"${meta.title}" 문제지를 삭제할까요? 되돌릴 수 없습니다.`)) return;
      await idbDeleteMeta(meta.id);
      await idbDeleteBlob(meta.id);
      renderExamList();
    });

    btnRow.appendChild(openBtn);
    btnRow.appendChild(delBtn);

    card.appendChild(title);
    card.appendChild(modeBadge);
    card.appendChild(meta_);
    card.appendChild(btnRow);
    examListDiv.appendChild(card);
  });
}

function showHome() {
  currentExamId = null;
  solveSection.style.display = "none";
  homeSection.style.display = "block";
  examFileInput.value = "";
  answerFileInput.value = "";
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
  const blob = await idbGetBlob(id);
  if (!meta || !blob) {
    alert("문제지를 불러올 수 없습니다.");
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
    await renderPDFToContainer(blob, examPagesDiv, 2.2);

    buildAnswerKeyTable(questionCount, meta.keyAnswers || new Array(questionCount).fill(""));
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

/* ---------------------------------------------------------
   다크모드
--------------------------------------------------------- */
(function initTheme() {
  const saved = localStorage.getItem("theme");
  const preferDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (preferDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "라이트모드" : "다크모드";
})();

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  themeToggle.textContent = next === "dark" ? "라이트모드" : "다크모드";
  localStorage.setItem("theme", next);
});

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
    await renderPDFToContainer(examFile, examPagesDiv, 2.2);

    if (examPagesDiv.childElementCount === 0) {
      loadStatus.textContent = "문제지 PDF에서 페이지를 찾지 못했습니다. 파일이 올바른지 확인해주세요.";
      showHome();
      return;
    }

    let extracted = new Array(questionCount).fill("");
    if (answerFile) {
      loadingText.textContent = "정답지를 분석하는 중...";
      extracted = await extractAnswerKey(answerFile);
      keyStatus.textContent = "정답이 자동으로 입력되었습니다. '정답 보기'를 눌러 확인하고, 틀린 항목은 직접 수정하세요.";
    } else {
      keyStatus.textContent = "정답지가 없습니다. '정답 보기'를 눌러 정답을 직접 입력하세요.";
    }

    buildAnswerKeyTable(questionCount, extracted);
    buildNavigator(questionCount);
    updateModeUI();
    setCurrentQuestion(1);
    updateLiveScore();

    // 저장: 이 문제지는 목록에서 삭제하기 전까지 계속 유지된다
    await idbPutBlob(id, examFile);
    await idbPutMeta({
      id,
      title,
      questionCount,
      keyAnswers: extracted,
      studentAnswers: {},
      judged: {},
      wasCorrect: {},
      mode: currentMode,
      testSubmitted: false,
      maxReached: 1,
      createdAt: Date.now(),
    });

    loadStatus.textContent = "";
  } catch (err) {
    console.error(err);
    loadStatus.textContent = "불러오는 중 오류가 발생했습니다: " + err.message;
    showHome();
  } finally {
    hideLoading();
  }
});

// PDF를 페이지별 캔버스로 렌더링
async function renderPDFToContainer(file, container, scale) {
  container.innerHTML = "";
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("캔버스를 생성할 수 없습니다 (2d context 없음)");
    }

    await page.render({ canvasContext: context, viewport: viewport }).promise;
    container.appendChild(canvas);
  }
}

// 정답지 PDF에서 정답 자동 추출 (정확도 개선판)
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

  // 전략 1 (우선): "문항번호 + 정답(원문자)" 짝 패턴을 직접 찾는다 (예: "1 ③", "11 ⑤").
  // 정답은 항상 원문자(①~⑤)로만 표기되고 배점(1~3)은 일반 숫자이므로,
  // group2를 원문자로만 한정하면 배점 숫자가 다음 문항번호와 뒤섞여 오탐되는 문제가 사라진다.
  const pattern = /(\d{1,2})\s*[.)]?\s*([①②③④⑤])/g;
  const found = {};
  let match;
  while ((match = pattern.exec(fullText)) !== null) {
    const qNum = parseInt(match[1], 10);
    const ans = circledMap[match[2]];
    if (qNum >= 1 && qNum <= questionCount && !found[qNum]) {
      found[qNum] = ans;
    }
  }
  if (Object.keys(found).length >= questionCount * 0.8) {
    const result = [];
    for (let i = 1; i <= questionCount; i++) result.push(found[i] || "");
    return result;
  }

  // 전략 2 (보조): 원문자가 문항 수 이상 등장하면 등장 순서를 1번~N번으로 가정한다.
  const circledMatches = fullText.match(/[①②③④⑤]/g) || [];
  if (circledMatches.length >= questionCount) {
    return circledMatches.slice(0, questionCount).map((c) => circledMap[c]);
  }

  // 전략 3: 실패 시 빈 값 (수동 입력)
  return new Array(questionCount).fill("");
}

// 정답 입력 표 (자동 추출 결과로 채워짐, 수정 가능)
function buildAnswerKeyTable(n, answers) {
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

    cell.appendChild(label);
    cell.appendChild(input);
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
}

// 큰 버튼 클릭 시 답 선택
document.querySelectorAll(".choiceBtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectAnswer(btn.dataset.choice);
  });
});

// 키보드 1~5로 답 선택, 좌우 화살표로 이전/다음 문제 이동
document.addEventListener("keydown", (e) => {
  if (solveSection.style.display === "none") return;
  if (["1", "2", "3", "4", "5"].includes(e.key)) {
    selectAnswer(e.key);
  } else if (e.key === "ArrowRight") {
    if (currentQuestion < questionCount) setCurrentQuestion(currentQuestion + 1);
  } else if (e.key === "ArrowLeft") {
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

  alert(`채점 완료! ${questionCount}문항 중 ${correctCountLive}개 정답입니다. 이제 문항을 자유롭게 오가며 정답을 확인할 수 있어요.`);
}

submitTestBtn.addEventListener("click", finishTest);

/* ---------------------------------------------------------
   시작: 홈 화면(문제지 목록)부터 보여준다
--------------------------------------------------------- */
showHome();
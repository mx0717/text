// pdf.js worker 설정
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js";

let questionCount = 50;
let correctCountLive = 0;
let answeredCountLive = 0;
let currentQuestion = 1;
let studentAnswers = {};   // { 1: "3", 2: "1", ... }
let judged = {};           // { 1: true/false } - 채점 완료 여부
let wasCorrect = {};       // { 1: true/false }
let examFileBlob = null;   // 저장/복원용 문제지 원본 파일

const examFileInput = document.getElementById("examFile");
const answerFileInput = document.getElementById("answerFile");
const questionCountInput = document.getElementById("questionCount");
const loadBtn = document.getElementById("loadBtn");
const loadStatus = document.getElementById("loadStatus");
const keyStatus = document.getElementById("keyStatus");

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

const deleteExamBtn = document.getElementById("deleteExamBtn");
const resetProgressBtn = document.getElementById("resetProgressBtn");

const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomLevelLabel = document.getElementById("zoomLevelLabel");
let zoomLevel = 1;

const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");

/* ---------------------------------------------------------
   저장 기능 (IndexedDB): 문제지를 한 번 불러오면 삭제 전까지 유지됨
--------------------------------------------------------- */
const DB_NAME = "hanguksaExamDB";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("examBlob")) db.createObjectStore("examBlob");
      if (!db.objectStoreNames.contains("examMeta")) db.createObjectStore("examMeta");
      if (!db.objectStoreNames.contains("progress")) db.createObjectStore("progress");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, key, value) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { console.error("저장 실패", e); return false; }
}

async function idbGet(storeName, key) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) { console.error("불러오기 실패", e); return null; }
}

async function idbDelete(storeName, key) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) { console.error("삭제 실패", e); return false; }
}

function getKeyAnswersFromDOM() {
  const arr = [];
  for (let i = 1; i <= questionCount; i++) {
    const el = document.getElementById("key" + i);
    arr.push(el ? el.value.trim() : "");
  }
  return arr;
}

async function saveExamMeta() {
  await idbPut("examMeta", "current", { questionCount, keyAnswers: getKeyAnswersFromDOM() });
}

async function saveProgress() {
  await idbPut("progress", "current", { studentAnswers, judged, wasCorrect });
}

// 페이지가 열릴 때 저장된 문제지가 있으면 자동으로 복원
(async function restoreSavedExam() {
  const blob = await idbGet("examBlob", "current");
  if (!blob) return;

  const meta = (await idbGet("examMeta", "current")) || {};
  questionCount = meta.questionCount || 50;
  questionCountInput.value = questionCount;
  examFileBlob = blob;

  try {
    loadStatus.textContent = "저장된 문제지를 불러오는 중...";
    examPagesDiv.innerHTML = "";
    zoomLevel = 1;
    applyZoom();
    mainSection.style.display = "block";
    await renderPDFToContainer(blob, examPagesDiv, 2.2);

    buildAnswerKeyTable(questionCount, meta.keyAnswers || new Array(questionCount).fill(""));
    buildNavigator(questionCount);

    const progress = await idbGet("progress", "current");
    if (progress) {
      studentAnswers = progress.studentAnswers || {};
      judged = progress.judged || {};
      wasCorrect = progress.wasCorrect || {};
      correctCountLive = 0;
      answeredCountLive = 0;
      for (let i = 1; i <= questionCount; i++) {
        if (judged[i]) {
          answeredCountLive++;
          if (wasCorrect[i]) correctCountLive++;
          const navBtn = document.getElementById("nav" + i);
          if (navBtn) navBtn.classList.add(wasCorrect[i] ? "correct" : "wrong");
        }
      }
    }

    setCurrentQuestion(1);
    updateLiveScore();
    keySection.style.display = "block";
    keyStatus.textContent = "저장된 정답입니다. '정답 보기'를 눌러 확인하거나 수정하세요.";
    loadStatus.textContent = "저장된 문제지를 불러왔습니다.";
  } catch (err) {
    console.error(err);
    loadStatus.textContent = "저장된 문제지를 불러오는 중 오류가 발생했습니다.";
  }
})();

/* ---------------------------------------------------------
   확대/축소
--------------------------------------------------------- */
function applyZoom() {
  examPagesDiv.style.width = (zoomLevel * 100) + "%";
  zoomLevelLabel.textContent = Math.round(zoomLevel * 100) + "%";
  zoomInBtn.disabled = zoomLevel >= 2.5;
  zoomOutBtn.disabled = zoomLevel <= 0.6;
  restartAnimation(zoomLevelLabel, "anim-pulse");
}

// 클래스를 지웠다가 다시 붙여서 CSS 애니메이션이 매번 재생되도록 강제한다
function restartAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // 강제 리플로우
  el.classList.add(className);
}

zoomInBtn.addEventListener("click", () => {
  zoomLevel = Math.min(2.5, Math.round((zoomLevel + 0.15) * 100) / 100);
  applyZoom();
});
zoomOutBtn.addEventListener("click", () => {
  zoomLevel = Math.max(0.6, Math.round((zoomLevel - 0.15) * 100) / 100);
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
  keyWrapper.classList.remove("blurred");
});

/* ---------------------------------------------------------
   문제지 삭제 / 푼 문제 초기화
--------------------------------------------------------- */
deleteExamBtn.addEventListener("click", async () => {
  if (!confirm("저장된 문제지와 정답, 풀이 기록을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;

  await idbDelete("examBlob", "current");
  await idbDelete("examMeta", "current");
  await idbDelete("progress", "current");

  examFileBlob = null;
  examFileInput.value = "";
  answerFileInput.value = "";
  studentAnswers = {};
  judged = {};
  wasCorrect = {};
  correctCountLive = 0;
  answeredCountLive = 0;

  mainSection.style.display = "none";
  keySection.style.display = "none";
  loadStatus.textContent = "문제지를 삭제했습니다. 새 문제지를 불러와주세요.";
});

resetProgressBtn.addEventListener("click", async () => {
  if (!confirm("지금까지 푼 답을 모두 지우고 다시 풀까요? 문제지와 정답은 유지됩니다.")) return;

  studentAnswers = {};
  judged = {};
  wasCorrect = {};
  correctCountLive = 0;
  answeredCountLive = 0;

  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("correct", "wrong"));
  setCurrentQuestion(1);
  updateLiveScore();
  await saveProgress();
});

/* ---------------------------------------------------------
   문제지 / 정답지 불러오기
--------------------------------------------------------- */
loadBtn.addEventListener("click", async () => {
  const examFile = examFileInput.files[0];
  const answerFile = answerFileInput.files[0];
  questionCount = parseInt(questionCountInput.value, 10) || 50;
  correctCountLive = 0;
  answeredCountLive = 0;
  currentQuestion = 1;
  studentAnswers = {};
  judged = {};
  wasCorrect = {};
  keyWrapper.classList.add("blurred");

  if (!examFile) {
    loadStatus.textContent = "문제지 PDF를 선택해주세요.";
    return;
  }

  try {
    loadStatus.textContent = "문제지를 불러오는 중...";
    examPagesDiv.innerHTML = "";
    zoomLevel = 1;
    applyZoom();
    mainSection.style.display = "block"; // 렌더링 전에 미리 보이는 상태로 전환 (숨김 상태에서 렌더링 시 깨지는 것 방지)
    await renderPDFToContainer(examFile, examPagesDiv, 2.2);

    if (examPagesDiv.childElementCount === 0) {
      loadStatus.textContent = "문제지 PDF에서 페이지를 찾지 못했습니다. 파일이 올바른지 확인해주세요.";
      return;
    }

    let extracted = new Array(questionCount).fill("");
    if (answerFile) {
      loadStatus.textContent = "정답지에서 정답을 추출하는 중...";
      extracted = await extractAnswerKey(answerFile);
      keyStatus.textContent = "정답이 자동으로 입력되었습니다. '정답 보기'를 눌러 확인하고, 틀린 항목은 직접 수정하세요.";
    } else {
      keyStatus.textContent = "정답지가 없습니다. '정답 보기'를 눌러 정답을 직접 입력하세요.";
    }

    buildAnswerKeyTable(questionCount, extracted);
    buildNavigator(questionCount);
    setCurrentQuestion(1);
    updateLiveScore();

    // 저장: 이 문제지는 삭제 버튼을 누르기 전까지 계속 유지된다
    examFileBlob = examFile;
    await idbPut("examBlob", "current", examFile);
    await saveExamMeta();
    await saveProgress();

    loadStatus.textContent = "불러오기 완료. (문제지는 삭제 전까지 저장됩니다)";
    keySection.style.display = "block";
  } catch (err) {
    console.error(err);
    loadStatus.textContent = "불러오는 중 오류가 발생했습니다: " + err.message;
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
  // 표가 여러 열로 나뉘어 있어도(1번 아래 2번, 오른쪽 열은 다른 번호) 문항번호 자체를 읽으므로 열 배치와 무관하게 정확하다.
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

  // 전략 2 (보조): 문항번호 짝짓기가 실패했을 때만 사용.
  // 원문자가 문항 수 이상 등장하면 등장 순서를 1번~N번으로 가정한다.
  // (표가 위→아래, 왼쪽 열→오른쪽 열 순서로 추출되는 PDF에서만 유효)
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
      // 정답을 수정하면 이미 채점된 문항은 다시 판정
      if (judged[i]) checkAnswer(i, studentAnswers[i]);
      saveExamMeta();
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
    btn.addEventListener("click", () => setCurrentQuestion(i));
    navigatorDiv.appendChild(btn);
  }
}

function setCurrentQuestion(i) {
  currentQuestion = i;
  currentQLabel.textContent = i + "번 문항의 답을 선택하세요";
  restartAnimation(currentQLabel, "anim-fade");
  feedbackDiv.textContent = "";
  feedbackDiv.className = "";

  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("current"));
  const navBtn = document.getElementById("nav" + i);
  if (navBtn) navBtn.classList.add("current");

  document.querySelectorAll(".choiceBtn").forEach((b) => {
    b.classList.toggle("selected", studentAnswers[i] === b.dataset.choice);
  });

  prevBtn.disabled = i <= 1;
  nextBtn.disabled = i >= questionCount;

  if (judged[i]) {
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
  if (mainSection.style.display === "none") return;
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
function selectAnswer(choice) {
  const i = currentQuestion;
  studentAnswers[i] = choice;
  document.querySelectorAll(".choiceBtn").forEach((b) => {
    b.classList.toggle("selected", b.dataset.choice === choice);
  });
  checkAnswer(i, choice);
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
  void navBtn.offsetWidth; // 강제 리플로우로 애니메이션 재생 보장
  navBtn.classList.add(isCorrect ? "correct" : "wrong");

  if (i === currentQuestion) showFeedback(i);
  updateLiveScore();
  saveProgress();
}

function showFeedback(i) {
  const correctAnswer = document.getElementById("key" + i).value.trim();
  feedbackDiv.textContent = "";
  feedbackDiv.className = "";
  void feedbackDiv.offsetWidth; // 강제 리플로우로 애니메이션 재생 보장
  if (wasCorrect[i]) {
    feedbackDiv.textContent = "정답입니다! ✅";
    feedbackDiv.className = "correct";
  } else {
    feedbackDiv.textContent = "오답입니다 ❌ (정답: " + (correctAnswer || "미입력") + ")";
    feedbackDiv.className = "wrong";
  }
}

function updateLiveScore() {
  liveScoreDiv.textContent = `맞은 개수: ${correctCountLive} / ${answeredCountLive} (전체 ${questionCount}문항 중 ${answeredCountLive}문항 풀이)`;
}
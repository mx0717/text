// ------------------------------------------------------------------
// 클라우드 동기화 (Firebase Authentication + Firestore)
//
// Storage는 사용하지 않습니다. (Firebase Storage는 기본 버킷을 만들려면
// Blaze 요금제/카드 등록이 필요해졌기 때문에, PDF 파일도 Firestore에
// 작은 조각(청크)으로 나눠 저장합니다. 완전히 무료(Spark) 플랜으로 동작해요.)
//
// 아래 firebaseConfig 값을 Firebase 콘솔 > 프로젝트 설정 > 내 앱 에서
// 복사해 붙여넣으세요. (storageBucket 값은 이제 필요 없습니다)
// ------------------------------------------------------------------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDocs,
  collection,
  deleteDoc,
  onSnapshot,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ⬇️⬇️⬇️ 여기에 Firebase 콘솔에서 복사한 설정값을 붙여넣으세요 ⬇️⬇️⬇️
const firebaseConfig = {
  apiKey: "AIzaSyAghbgSZ57amoZnwM10O1uTIXbtbV1rJ8M",
  authDomain: "hanguksa-exam.firebaseapp.com",
  projectId: "hanguksa-exam",
  messagingSenderId: "996147968420",
  appId: "1:996147968420:web:cc6d710777562d90e9e931",
};
// ⬆️⬆️⬆️ 여기까지 ⬆️⬆️⬆️
 
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
 
let unsubscribeSnapshot = null;
 
/* ---------------------------------------------------------
   인증 (Google 로그인)
--------------------------------------------------------- */
export function onAuthChange(callback) {
  onAuthStateChanged(auth, callback);
}
 
export async function signIn() {
  await signInWithPopup(auth, provider);
}
 
export async function signOutUser() {
  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }
  await signOut(auth);
}
 
export function getCurrentUser() {
  return auth.currentUser;
}
 
/* ---------------------------------------------------------
   Firestore: 문제지 메타데이터(정답, 풀이기록, 필기 등)
   문서 하나 = 문제지 하나. 필드가 중첩 배열을 포함해도 되도록
   JSON 문자열(data)로 통째로 저장한다.
--------------------------------------------------------- */
function examDocRef(uid, examId) {
  return doc(db, "users", uid, "exams", examId);
}
 
export async function pushMeta(uid, examId, meta) {
  try {
    await setDoc(examDocRef(uid, examId), {
      data: JSON.stringify(meta),
      updatedAt: meta.updatedAt || Date.now(),
    });
    return true;
  } catch (e) {
    console.error("클라우드 저장 실패", e);
    return false;
  }
}
 
export async function fetchAllRemoteMetas(uid) {
  const snap = await getDocs(collection(db, "users", uid, "exams"));
  const result = [];
  snap.forEach((d) => {
    try {
      result.push(JSON.parse(d.data().data));
    } catch (e) {
      console.error("원격 데이터 파싱 실패", e);
    }
  });
  return result;
}
 
// 다른 기기에서 생긴 변경을 실시간으로 받는다
export function subscribeRemoteChanges(uid, onChange) {
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  unsubscribeSnapshot = onSnapshot(
    collection(db, "users", uid, "exams"),
    (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === "removed") {
          onChange({ type: "removed", examId: change.doc.id });
          return;
        }
        try {
          const meta = JSON.parse(change.doc.data().data);
          onChange({ type: "upsert", examId: change.doc.id, meta });
        } catch (e) {
          console.error("원격 변경 파싱 실패", e);
        }
      });
    },
    (err) => console.error("실시간 동기화 오류", err)
  );
}
 
/* ---------------------------------------------------------
   파일(PDF)을 Firestore에 base64 청크로 나눠 저장한다.
   users/{uid}/exams/{examId}/files_{kind}/{0,1,2,...}
   (kind는 "exam" 또는 "answer")
--------------------------------------------------------- */
const CHUNK_CHARS = 400000; // base64 문자 기준, 문서당 약 400KB (요청 하나가 너무 커지지 않도록 여유있게)
 
function fileCollectionRef(uid, examId, kind) {
  return collection(db, "users", uid, "exams", examId, "files_" + kind);
}
 
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // "data:application/pdf;base64,AAAA..."
      const comma = result.indexOf(",");
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
 
async function deleteFileChunks(uid, examId, kind) {
  const snap = await getDocs(fileCollectionRef(uid, examId, kind));
  const refs = [];
  snap.forEach((d) => refs.push(d.ref));
  // 삭제는 조각당 데이터가 없어 가벼우므로 병렬로 처리해도 안전하다
  await Promise.all(refs.map((r) => deleteDoc(r)));
}
 
// onProgress(current, total) - 선택: 진행 상황을 화면에 표시하고 싶을 때 전달
export async function uploadBlob(uid, examId, kind, blob, onProgress) {
  try {
    const base64 = await blobToBase64(blob);
    const totalChunks = Math.max(1, Math.ceil(base64.length / CHUNK_CHARS));
 
    await deleteFileChunks(uid, examId, kind); // 이전 조각 정리 (덮어쓰기 대비)
 
    const colRef = fileCollectionRef(uid, examId, kind);
    // 조각을 하나씩 순서대로 보낸다 (한 번에 너무 많이 묶으면 요청이 너무 커져 멈출 수 있다)
    for (let i = 0; i < totalChunks; i++) {
      const chunkStr = base64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
      await setDoc(doc(colRef, String(i)), { data: chunkStr, index: i, total: totalChunks });
      if (onProgress) onProgress(i + 1, totalChunks);
    }
    return true;
  } catch (e) {
    console.error("파일 업로드 실패", e);
    return false;
  }
}
 
export async function downloadBlob(uid, examId, kind, onProgress) {
  try {
    const snap = await getDocs(fileCollectionRef(uid, examId, kind));
    if (snap.empty) return null;
    const chunks = [];
    snap.forEach((d) => chunks.push(d.data()));
    chunks.sort((a, b) => a.index - b.index);
    if (onProgress) onProgress(chunks.length, chunks.length);
    const base64 = chunks.map((c) => c.data).join("");
    const res = await fetch(`data:application/pdf;base64,${base64}`);
    return await res.blob();
  } catch (e) {
    console.error("파일 다운로드 실패", e);
    return null;
  }
}
 
export async function deleteRemoteExam(uid, examId) {
  try {
    await deleteDoc(examDocRef(uid, examId));
  } catch (e) {
    console.error("클라우드 문서 삭제 실패", e);
  }
  await Promise.all([
    deleteFileChunks(uid, examId, "exam"),
    deleteFileChunks(uid, examId, "answer"),
  ]);
}
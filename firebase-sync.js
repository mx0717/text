// ------------------------------------------------------------------
// 클라우드 동기화 (Firebase Authentication + Firestore + Storage)
//
// 아래 firebaseConfig 값을 Firebase 콘솔 > 프로젝트 설정 > 내 앱 에서
// 복사해 붙여넣으세요. (큰따옴표 안의 내용만 바꾸면 됩니다)
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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getBytes,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// ⬇️⬇️⬇️ 여기에 Firebase 콘솔에서 복사한 설정값을 붙여넣으세요 ⬇️⬇️⬇️
const firebaseConfig = {
  apiKey: "AIzaSyAghbgSZ57amoZnwM10O1uTIXbtbV1rJ8M",
  authDomain: "hanguksa-exam.firebaseapp.com",
  projectId: "hanguksa-exam",
  storageBucket: "hanguksa-exam.firebasestorage.app",
  messagingSenderId: "996147968420",
  appId: "1:996147968420:web:cc6d710777562d90e9e931",
};
// ⬆️⬆️⬆️ 여기까지 ⬆️⬆️⬆️

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
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

export async function deleteRemoteExam(uid, examId) {
  try {
    await deleteDoc(examDocRef(uid, examId));
  } catch (e) {
    console.error("클라우드 문서 삭제 실패", e);
  }
  await Promise.all([
    deleteRemoteBlob(uid, examId, "exam"),
    deleteRemoteBlob(uid, examId, "answer"),
  ]);
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
   Storage: 문제지/정답지 PDF 원본
--------------------------------------------------------- */
function blobRef(uid, examId, kind) {
  return ref(storage, `users/${uid}/exams/${examId}/${kind}.pdf`);
}

export async function uploadBlob(uid, examId, kind, blob) {
  try {
    await uploadBytes(blobRef(uid, examId, kind), blob);
    return true;
  } catch (e) {
    console.error("파일 업로드 실패", e);
    return false;
  }
}

export async function downloadBlob(uid, examId, kind) {
  try {
    const bytes = await getBytes(blobRef(uid, examId, kind));
    return new Blob([bytes], { type: "application/pdf" });
  } catch (e) {
    return null; // 원격에 없음 (예: 정답지를 올리지 않은 경우)
  }
}

async function deleteRemoteBlob(uid, examId, kind) {
  try {
    await deleteObject(blobRef(uid, examId, kind));
  } catch (e) {
    // 파일이 애초에 없으면 조용히 무시
  }
}
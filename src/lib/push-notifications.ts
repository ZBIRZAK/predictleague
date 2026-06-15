import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { registerPushSubscription } from './db';
import { firebaseApp } from './firebase';

const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY ?? '';

function serviceWorkerUrl() {
  const params = new URLSearchParams({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: import.meta.env.VITE_FIREBASE_APP_ID ?? ''
  });
  return `/firebase-messaging-sw.js?${params.toString()}`;
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Push notifications are not supported by this browser.');
  }
  return navigator.serviceWorker.register(serviceWorkerUrl(), { scope: '/' });
}

export async function enablePushNotifications() {
  if (!(await isSupported())) {
    throw new Error('Push notifications are not supported by this browser.');
  }
  if (!vapidKey) {
    throw new Error('Firebase Web Push is not configured.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const registration = await getRegistration();
  const token = await getToken(getMessaging(firebaseApp), {
    vapidKey,
    serviceWorkerRegistration: registration
  });
  if (!token) {
    throw new Error('Firebase did not return a notification token.');
  }

  await registerPushSubscription(token);
  return token;
}

export async function syncPushSubscriptionIfAllowed() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  await enablePushNotifications();
}

export async function listenForForegroundPush() {
  if (!(await isSupported())) return () => undefined;
  return onMessage(getMessaging(firebaseApp), (payload) => {
    if (Notification.permission !== 'granted') return;
    const notification = new Notification(payload.data?.title ?? payload.notification?.title ?? 'PrediLeague', {
      body: payload.data?.body ?? payload.notification?.body ?? '',
      icon: '/brand-mark.svg',
      data: { link: payload.data?.link ?? '/#game' }
    });
    notification.onclick = () => {
      window.focus();
      window.location.href = String(notification.data?.link ?? '/#game');
      notification.close();
    };
  });
}

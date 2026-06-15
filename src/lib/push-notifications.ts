import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { registerPushSubscription } from './db';
import { firebaseApp } from './firebase';

const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY ?? '';

async function getRegistration() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Push notifications are not supported by this browser.');
  }
  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
    scope: '/',
    updateViaCache: 'none'
  });
  await registration.update();
  return navigator.serviceWorker.ready;
}

function pushRegistrationMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes('push service error')) {
    return 'The browser push service could not register this device. Reload the app and try again. If it still fails, allow notifications and service workers for this site in the browser settings.';
  }
  return message || 'Failed to register this device for push notifications.';
}

async function getFirebaseToken(registration: ServiceWorkerRegistration) {
  const messaging = getMessaging(firebaseApp);
  try {
    return await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration
    });
  } catch (firstError) {
    const existingSubscription = await registration.pushManager.getSubscription().catch(() => null);
    if (!existingSubscription) {
      throw new Error(pushRegistrationMessage(firstError));
    }

    await existingSubscription.unsubscribe().catch(() => false);
    try {
      return await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: registration
      });
    } catch (retryError) {
      throw new Error(pushRegistrationMessage(retryError));
    }
  }
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
  const token = await getFirebaseToken(registration);
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

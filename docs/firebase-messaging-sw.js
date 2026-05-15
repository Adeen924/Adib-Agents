// Firebase Messaging Service Worker
// Handles push notifications when the app is in the background or closed.
// This file must stay at the root of the served directory (same level as dashboard.html).

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// Firebase config is duplicated here because service workers cannot import
// regular JS modules from the page. Keep in sync with firebase-config.js.
firebase.initializeApp({
  apiKey:            "AIzaSyAO49Qyo638mugQOtri2Wt02eyPms1Ipv0",
  authDomain:        "adib-job-agent.firebaseapp.com",
  projectId:         "adib-job-agent",
  storageBucket:     "adib-job-agent.firebasestorage.app",
  messagingSenderId: "983490320341",
  appId:             "1:983490320341:web:c5cec62a3c827b56f18f5c",
});

const messaging = firebase.messaging();

// Background message handler — fires when the app tab is closed or not focused
messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || "Adib Agents";
  const body  = payload.notification?.body  || "";
  const link  = payload.data?.link          || "/Adib-Agents/dashboard.html";

  return self.registration.showNotification(title, {
    body,
    icon:  "/Adib-Agents/favicon.ico",
    badge: "/Adib-Agents/favicon.ico",
    data:  { link },
    requireInteraction: false,
  });
});

// Open (or focus) the dashboard when the user taps a notification
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const link = event.notification.data?.link || "/Adib-Agents/dashboard.html";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes("dashboard.html") && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow(link);
    })
  );
});

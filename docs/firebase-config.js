// Get these values from:
// Firebase Console → Project Settings → Your apps → (add a Web app if you haven't) → Config
const firebaseConfig = {
  apiKey:            "AIzaSyAO49Qyo638mugQOtri2Wt02eyPms1Ipv0",
  authDomain:        "adib-job-agent.firebaseapp.com",
  projectId:         "adib-job-agent",
  storageBucket:     "adib-job-agent.firebasestorage.app",
  messagingSenderId: "983490320341",
  appId:             "1:983490320341:web:c5cec62a3c827b56f18f5c",

  // FCM Web Push (VAPID) key.
  // How to get it: Firebase Console → Project Settings → Cloud Messaging
  //   → Web configuration → Generate key pair → copy the Key string
  vapidKey: "YOUR_VAPID_KEY_HERE",

  // The live URL of this site — used so notification taps open the right page.
  // Change this if you ever move to a custom domain.
  siteUrl: "https://adeen924.github.io/Adib-Agents",
};

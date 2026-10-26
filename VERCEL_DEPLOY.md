# Vercel static version

The website is hosted as static files on Vercel. The deployment uses the isolated `vercel-site/` staging directory, which contains only `index.html` and `web-static/`; the Flask app, Python detection code, and original MOV files stay in the local project.

## Deploy on Vercel

1. Install Node.js on the computer used for deployment and sign in with `npx vercel login`.
2. Open PowerShell in `D:\code` and run `.\deploy-vercel.ps1`. It refreshes `vercel-site/` from the source files and publishes Production.
3. Open the Production URL on a phone or tablet over HTTPS.

Production URL: https://code-amber-three.vercel.app

Vercel Hobby is free for personal, non-commercial use, with usage limits. The 75 optimized sign clips total about 7.5 MB. See [Vercel limits](https://vercel.com/docs/limits) and [Hobby plan](https://vercel.com/docs/plans/hobby).

## Browser processing

The site uses browser speech recognition and speech synthesis. Camera processing runs with MediaPipe in the visitor's browser. The camera recognizes only ฉัน, พ่อ, แม่, โกรธ, รัก, ป่วย/ไม่สบาย, and ช่วยฉันด้วย.

Camera frames are processed on the device and are not sent to the app server. MediaPipe's documentation says it sends usage metrics, so the page discloses that to visitors. The WASM runtime and landmark models load from jsDelivr and Google Storage when the camera is started.

Speech recognition support depends on the browser and device; typing is the fallback. For camera access, visitors must open the deployed HTTPS URL and allow camera access.

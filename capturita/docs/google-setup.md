# Set up uploads to YouTube and Google Drive

[← User guide](user.md)

Capturita uploads with **your own** free Google Cloud project. No Google keys ship with the app,
so every person uses their own account and their own keys, and nobody else's. It takes about
5 minutes, once. You don't need it to record, edit or export MP4s.

When you're done, paste the Client ID and Client Secret in **Settings (⚙) → Google**.

## The steps

Use the Google account you want to upload with. At the top of every Cloud Console page, check
the project picker shows the project you created.

**1. Create a project.** Open [Create a project](https://console.cloud.google.com/projectcreate),
name it anything (for example *Capturita*) and click **Create**.

**2. Turn on YouTube and Drive.** Open [Enable the APIs](https://console.cloud.google.com/flows/enableapi?apiid=youtube.googleapis.com,drive.googleapis.com),
check your project is selected, click **Next**, then **Enable**. That turns on both the
*YouTube Data API v3* and the *Google Drive API*.

**3. Set up the sign-in screen.** Open [Google Auth Platform](https://console.cloud.google.com/auth/overview)
and click **Get started**:
- App name: *Capturita*. User support email: your email.
- Audience: **External**.
- Contact information: your email.
- Agree to the policy and click **Create**.

**4. Publish it, so you stay signed in.** Open [Audience](https://console.cloud.google.com/auth/audience),
click **Publish app** and confirm.

While a project is in *Testing*, Google signs you out every 7 days. Publishing stops that. It
doesn't need Google's review for your own use; it only means the "unverified app" screen
appears when you sign in (step 7). If you'd rather keep it in Testing, add your email under
**Test users** on the same page, and sign in again each week.

**5. Create the client.** Open [Clients](https://console.cloud.google.com/auth/clients) and click
**Create client**:
- Application type: **Desktop app**
- Name: *Capturita*
- Click **Create**.

Copy the **Client ID** and the **Client Secret** now. Google shows the secret only once (if you
lose it, open the client and add a new secret).

**6. Paste them into Capturita.** **Settings (⚙) → Google**, paste both, **Save**.

**7. Upload.** Export to YouTube or Drive. Your browser opens Google's sign-in:
1. Pick your account.
2. Google says **"Google hasn't verified this app"**. That's expected: it's your own app. Click
   **Advanced**, then **Go to Capturita (unsafe)**.
3. Tick the box that allows uploading (YouTube) or Drive files, and click **Continue**.

The upload starts. Next time it uploads straight away.

## Your privacy

- **Your keys stay on your Mac.** The Client ID, Client Secret and sign-in are kept in the macOS
  Keychain. They're never in the app, its files or a download.
- **Each user brings their own.** Someone else using Capturita sets up their own project; they
  can't use yours, and you can't use theirs.
- **Capturita never sees your password.** You sign in on Google's own page in your browser;
  Capturita only gets a permission that you can withdraw any time.
- **No server in between.** Videos go straight from your Mac to Google.
- **Only two narrow permissions:**
  - *YouTube upload* (Google words it "Manage your YouTube videos"): the upload-only permission,
    the narrowest YouTube offers. Capturita uses it only to upload.
  - *Drive files it creates* ("See, edit, create, and delete only the specific Google Drive files
    you use with this app"): it can't see anything else in your Drive.

To withdraw access: **Settings → Google → Sign out** (also cancels it on Google's side), or
remove *Capturita* at [myaccount.google.com/connections](https://myaccount.google.com/connections).

## Good to know

- **YouTube uploads stay private** until Google audits your project (a review meant for public
  apps). To publish a video, upload it, then open it in [YouTube Studio](https://studio.youtube.com)
  and change the visibility there, or upload the exported MP4 in YouTube Studio.
- **Up to 100 people** can ever sign in to an unaudited project. Plenty for you; each person
  should use their own project anyway.
- **Daily limit:** Google allows a limited number of uploads per project per day (around 6
  YouTube uploads on a new project). Drive has no practical limit.

## Troubleshooting

| Capturita says | Fix |
|---|---|
| "Add your Google Client ID and Client Secret in Settings → Google first" | Steps 5 and 6. |
| "That doesn't look like a Google Client ID" | Copy the Client ID, not the project ID or number. It ends in `.apps.googleusercontent.com`. |
| "Google didn't accept your Client ID and Client Secret" | They're from different clients, or the secret was reset. Copy both from the same Desktop app client (add a new secret if needed) and save again. |
| "The YouTube Data API v3 isn't turned on" (or Drive) | Step 2, in the same project as the client. Wait a minute after enabling. |
| "This Google account has no YouTube channel yet" | Create a channel at [youtube.com](https://www.youtube.com) with that account. |
| "Google signed you out" every week | Step 4: publish the project. |
| "Capturita needs the upload permission" | You unticked the permission box while signing in. Upload again and keep it ticked. |
| Google shows **"Access blocked"** or **"Error 403: access_denied"** | The project is in Testing and your account isn't a test user. Do step 4 (publish), or add your email under Test users. |
| Google shows **"Error 400: redirect_uri_mismatch"** | The client isn't a **Desktop app**. Create a new client of type Desktop app (step 5). |
| "Google's daily upload limit … is used up" | Try tomorrow, or upload the MP4 in YouTube Studio. |
| "Google sign-in timed out" | Finish signing in within 5 minutes of the browser opening, or try again. |

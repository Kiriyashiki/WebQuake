# AXIS EEW

[ **English** | [日本語](./AXIS-about-ja.md) ]

<a href="https://axis.prioris.jp/">AXIS</a> is a free service that distributes EEW (Earthquake Early Warning) reports via WebSocket.<br>
By connecting WebQuake to AXIS, you can recieve EEWs.

## Important
 
- AXIS is in BETA TEST. Errors and other issues may arise
- Redistribution, reprinting, reproduction, modification, or commercial use of information received via AXIS is prohibited.
- Please exercise caution if you are recording or streaming videos or similar content, specifically to public social media (Twitter, Youtube...)
- The EEW implementation in WebQuake is similarly experimental. Please report any issues.

## How to use

Firstly, you will need an account on AXIS. If you haven't already, please [sign up](https://axis.prioris.jp/accounts/signup/).<br>
Most of the website is in Japanese only. This guide will help you, but you may also use the translation function on your browser, if you have one.

### Sign up

AXIS requires a [GitHub](https://github.com/) account. Click 'GitHubでサインアップ' button, then '続ける' to connect.


<img src="./img-signup.png" width=300>

### Select channel

You need to set the channel to `eew` to recieve EEWs. Click 'Channel' on the top bar.

<img src="./img-bar.png" height=40>

Under 'チャンネル選択', select `eew` from the dropdown, and click '変更'.

<img src="./img-channel.png" width=600>

### Get token

*If your token ever expires, you can get a new one here.*

Click 'Access Token' on the top bar. Under 'AXIS Access Token', you can find a large set of characters. Select it and copy it.

<img src="./img-token.png" width=500>

Now you can just paste it under 'AXIS Token • トークン' in WebQuake settings, and enable EEWs.

*If an error occurs, make sure you correctly copy/pasted the token.*


## Token expiry

The AXIS token expires at the end of each month. Due to security limitations within browser envrionments (CORS), there is currently no safe way to refresh the token automatically, and it will need to be done via other means.

You can either get a new one from the AXIS dashboard, or use [KyoshinEewViewer](https://svs.ingen084.net/kyoshineewviewer/), which auto refreshes the token.

*You can have up to two concurrent connections with AXIS, so you can use both WebQuake and another app (like KEVI) at the same time.*

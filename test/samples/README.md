# Data samples

This folder contains sample data for these JMA earthquake report types:

- `VXSE51`: 震度速報 - Intensity Flash
- `VXSE52`: 震源速報 / 震源に関する情報 - Epicenter Flash
- `VXSE53`: 震源・震度情報 / 震源・震度に関する情報 - Intensity & Epicenter Information
- `VXSE61`: 顕著な地震の震源要素更新のお知らせ - Epicenter update announcement for Notable Earthquake
- `VXSE62`: 長周期地震動に関する観測情報 - Long-period ground motion (LPGM) Information

The `json` files are from AXIS' `jmx-seismology` channel, with the matching `xml` files from JMA's feed.</br>
Additionally, the `AXIS-EEW.json` provides a full Earthquake Early Warning (Forecast + Warning) sequence from AXIS' `eew` channel.<br/>
All samples are from the same earthquake event and thus represent a full event sequence. Note that multiple instances of the same report type may be recieved from a real sequence; those samples only provide one of each.

Those samples are free to use, without any attribution required.</br>
I believe they may be useful to those aiming to use AXIS' data, so please enjoy :)

---

# データサンプル

このフォルダには、以下の気象庁（JMA）地震報告種別のサンプルデータが含まれています:

- `VXSE51`: 震度速報
- `VXSE52`: 震源速報 / 震源に関する情報
- `VXSE53`: 震源・震度情報 / 震源・震度に関する情報
- `VXSE61`: 顕著な地震の震源要素更新のお知らせ
- `VXSE62`: 長周期地震動に関する観測情報

`json` ファイルはAXISの `jmx-seismology` チャンネルからのもので、対応する `xml` ファイルは気象庁のフィードからのものです。</br>
さらに、`AXIS-EEW.json` はAXISの `eew` チャンネルからの緊急地震速報（予報＋警報）の一連のシーケンス全体を提供します。<br/>
すべてのサンプルは同じ地震イベントからのものであるため、一つのイベントシーケンス全体を表しています。実際のシーケンスでは、同じ報告種別の複数のインスタンスを受信する可能性があることに注意してください。これらのサンプルは各種別につき一つずつしか提供していません。

これらのサンプルは自由に使用でき、クレジット表示も不要です。</br>
AXISのデータを利用しようとしている方々の役に立つと考えているので、ぜひ楽しんでください :)

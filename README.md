# KyoQuake

Web-based that displays information from earthquake reports published by the Japan Meteorological Agency (JMA · 気象庁)

![Main app view](./extra/main.png)

Live at [kyoquake.hainaut.xyz](https://kyoquake.hainaut.xyz?utm_source=github)

Desktop apps available in [Releases](https://github.com/Kiriyashiki/WebQuake/releases) (beta)

## Features

- List of part earthquakes (up to 30 days old)
- Description of the earthquake (Mangitude, Intensity, Date and Time, etc.)
- On map visualization of the epicenter, and recorded intensity by area/city
- Full list of localities sorted by their recorded intensity
- Bilingual setup (Japanese and English)
- Live mode to pull new reports and open them automatically
- Home location setting to add a marker to a selected location on map, and easily view intensity for that location when viewing a report
- Earthquake history with search criteria
- Earthquake Early Warning (experimental)

## Dev

This project uses Vite.js with NodeJS, and is written in vanilla JavaScript.<br>
The prefered package manager is pnpm.

### Build

```bash
pnpm install
pnpm run build
```
## Links

### Attribution · Sources

- [Japan Meteorological Agency (JMA · 気象庁)](https://www.jma.go.jp/jma/index.html)<br>
    - <a href="https://www.jma.go.jp/bosai/">Bosai · 防災情報</a>: Earthquake reports json feed
    - <a href="https://xml.kishou.go.jp/xmlpull.html">XML Pull</a>: Earthquake reports xml feed
    - <a href="https://www.data.jma.go.jp/developer/gis.html">GIS Area data</a>: Map data of prefectures/forecast areas
    - <a href="https://www.data.jma.go.jp/developer/multilingual.html">Area/City names</a>: Name definition of area/city codes
    - <a href="https://www.data.jma.go.jp/eqdb/data/shindo/">EQDB</a>: Historical Earthquake data
    - <a href="https://axis.prioris.jp/">AXIS</a>: EEW source
- <a href="https://jquake.net/">JQuake</a>: Intensity color scale
- <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>: Map data of lakes
- [M PLUS Fonts](https://mplusfonts.github.io/) Font family used

### Useful

- [Explaination of the intensity values - JMA](https://www.data.jma.go.jp/multi/quake/quake_advisory.html?lang=en)
- [Past earthquakes up to 30 days - JMA](https://www.data.jma.go.jp/multi/quake/index.html?lang=en)

### Name

The name 'KyoQuake' is simply a combinaison of the character 京 (kyou), which is a short for 京都 (Kyoto), and 'Quake' for earthquake.<br>
'Kyo' can as well be a reference to 強 (kyou) for 強震 (kyoushin, Strong-motion) or JMA intensities ５強 and ６強.
The reference to Kyoto is simply a personal preference. This app still covers all of Japan :)<br>

The app was formerly known as 'WebQuake', which was in my opinion too generic. For convenience, it remains as an internal ID and repository name.

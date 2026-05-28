# Static reports

WebQuake allows loading static reports that are displayed by clicking 'Load notables' at the bottom of the report list.<br>
This can be useful to make reports persist after they are removed from the JMA feed.

As an example, I've loaded reports of some past major earthquakes in the folder.<br>
Each report is indexed in `list.txt` so the app knows which reports are available to fetch.

`extra/generateEqdbReport.js` can be used to create json reports matching the JMA feed format from the JMA Earthquake Database (EQDB) at https://www.data.jma.go.jp/eqdb/data/shindo - simply give it the event ID found in the URL when opening an entry on map (like https://www.data.jma.go.jp/eqdb/data/shindo/#20160616142128 -> ID is 20160616142128).

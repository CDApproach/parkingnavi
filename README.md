# ParkingNavi

Webkarte, die zum nächsten öffentlichen Parkplatz navigiert.

**Live:** https://cdapproach.github.io/parkingnavi/

## Funktionen

- **Basemap umschaltbar:** Topo (OpenTopoMap) oder Satellit (Esri World Imagery mit Straßen- und Ortsbeschriftung)
- **GPS des Geräts:** eigene Position mit Genauigkeitskreis und Fahrtrichtung, Karte folgt der Position
- **Nächster Parkplatz:** sucht öffentliche Parkplätze aus OpenStreetMap im Umkreis (1,5 → 4 → 10 km),
  vergleicht die 8 nächstgelegenen nach echter Fahrzeit und startet die Route zum schnellsten.
  Alternativen werden im Bedienfeld angezeigt.
- **Navigation:** Abbiegehinweise auf Deutsch, Sprachansagen, automatische Neuberechnung beim Verlassen
  der Route, Bildschirm bleibt während der Navigation an.
- Parkplätze im Kartenausschnitt (ab Zoom 14), farbig nach Gebühr: grün = kostenlos, orange = kostenpflichtig, blau = unbekannt.
  Popup mit Kapazität, Gebühr, Öffnungszeiten – plus Link zu Google Maps.

## Datenquellen

| Zweck | Dienst |
|---|---|
| Parkplätze | OpenStreetMap über die [Overpass API](https://overpass-api.de) (`amenity=parking`, ohne `access=private/customers/…`) |
| Routing | [OSRM](https://project-osrm.org) Demo-Server (Profil Auto) |
| Karten | [OpenTopoMap](https://opentopomap.org), [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) |

Die öffentlichen Overpass- und OSRM-Server sind für geringe Nutzung gedacht. Bei viel Verkehr eigene Instanzen
eintragen (`OVERPASS_ENDPOINTS` und `OSRM` oben in `app.js`).

## Lokal testen

```bash
python3 -m http.server 8000
```

Dann http://localhost:8000 öffnen. GPS funktioniert im Browser nur über HTTPS oder `localhost`.

## Veröffentlichung

Jeder Push auf `main` wird per GitHub Actions auf GitHub Pages veröffentlicht
(einmalig nötig: *Settings → Pages → Source: GitHub Actions*).

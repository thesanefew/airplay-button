# AirPlay Button

A free Safari userscript that adds an **AirPlay** button to any web video, including custom players that hide it. It also sends the site's **subtitles** to your Apple TV.

## Features

- **AirPlay on any player.** Re-enables AirPlay on videos that switch it off, including players embedded in iframes.
- **Subtitles on the TV.** Takes the subtitle file the site loaded (`.vtt` or `.srt`) and sends it to the TV as a real subtitle track, timed to the video.
- **Works with HLS players.** Players built on MediaSource (hls.js and similar) normally can't AirPlay. The script switches them to Safari's native HLS playback when you press the button.
- **Stays out of the way.** The button only appears when an AirPlay device is on your network, fades out during playback and works in fullscreen.

## Install

1. Install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) from the Mac App Store (free).
2. In **Safari → Settings → Extensions**, enable **Userscripts** and set it to **Always Allow on Every Website**. This is needed so the script also runs inside embedded players.
3. Open [`airplay-button.user.js`](https://raw.githubusercontent.com/thesanefew/airplay-button/main/airplay-button.user.js) in Safari, click the Userscripts toolbar icon and choose **Install**.

## Use

1. Play a video and move the mouse over it. An **AirPlay** button appears in the top-right corner.
2. To get subtitles, first turn them on in the site's player. Wait until the button says **AirPlay + CC**.
3. Click the button and pick your TV.

If the subtitles don't appear on the TV, open the subtitle menu on the Apple TV remote and select **Subtitles**.

## How subtitles work

AirPlay only shows subtitles listed inside the video's HLS playlist. Most sites load a separate subtitle file and draw it over the video themselves, so the TV never receives it.

The script builds a new HLS master playlist that adds the site's subtitle file as a subtitle track. It reads the first video segment's timestamp so the subtitles stay in sync. The playlist, subtitle playlist and subtitles are all packed into `data:` URLs, so no server is needed.

## Limitations

- Safari only. Chrome and Firefox don't support AirPlay.
- DRM-protected video (Netflix, Disney+ and similar) won't work.
- Some video servers block requests from the Apple TV, which fetches the stream itself.
- Subtitle sync is automatic for MPEG-TS streams. Encrypted and fMP4 streams assume a start time of 0.

## Troubleshooting

Open **Develop → Show JavaScript Console** in Safari and look for lines starting with `[AirPlay Button]`. Please include them when you [open an issue](https://github.com/thesanefew/airplay-button/issues).

## License

MIT. AirPlay is a trademark of Apple Inc. This project is not affiliated with Apple.

# Mobile typography assets

These are self-hosted WOFF2 subsets for Pet's mobile page. They do not install
fonts on the phone or host OS. The original OFL licenses accompany the files.
The subsets use the internal family names Huahua Title, Huahua Text and Huahua UI.

| Role | Upstream | Source | Subset size |
| --- | --- | --- | --- |
| Titles | ChillRoundGothic Medium | [Official repository](https://github.com/Warren2060/ChillRoundGothic), `woff/ChillRoundGothic_Medium.woff`, downloaded 2026-10-01 | 104,760 bytes |
| Conversation and personal text | LXGW WenKai Lite Medium v1.522 | [Official release](https://github.com/lxgw/LxgwWenKai-Lite/releases/tag/v1.522), `LXGWWenKaiLite-Medium.ttf` | 1,635,960 bytes |
| Interface and system text | Noto Sans SC, static weight 400 | Existing local `NotoSansSC-VF.ttf`; [official font and license](https://github.com/google/fonts/tree/main/ofl/notosanssc) | 63,928 bytes |

The title and interface files cover the static page's characters, Latin text and
punctuation. The dialogue file adds the GB2312 repertoire; other characters use
the next font in the CSS stack. Color emoji use the platform's emoji font.
Total font payload is 1,804,648 bytes (about 1.72 MiB). The dialogue font loads
when its text is displayed. `font-display: swap` keeps text visible while loading.
Versioned filenames are cached for one year; CSS remains revalidated.

To rebuild, put the three upstream files in a temporary source directory as
`title-source.woff`, `text-source.ttf`, `ui-source.ttf`, together with
`OFL-title.txt`, `OFL-text.txt`, `OFL-ui.txt`, then run:

```sh
python3 scripts/build-mobile-fonts.py /path/to/font-sources
```

The build requires fontTools and Brotli. They are build tools only. Update the
font filename version and CSS URLs when changing the subsets so cached fonts
cannot hide a new version.

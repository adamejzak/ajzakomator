
## Which download should I choose?

Choose from the assets attached to this release. The version number in the file name changes with each release; a Windows-only release may not include Mac packages.

| Your computer | Download | How to use it |
| --- | --- | --- |
| **Windows 10 / 11 (x64)** | `ajzakomator-Setup-<version>.exe` | **Recommended installer.** Installs the app and creates shortcuts. Installed builds support automatic updates. |
| **Windows, without installation** | `ajzakomator-Portable-<version>.exe` | **Portable:** run the executable directly, without a setup wizard. Update it manually by downloading a new executable. |
| **Mac with Apple Silicon** — M1, M2, M3, M4 or newer | `ajzakomator-<version>-mac-arm64.dmg` | **Recommended for Apple Silicon.** Open the DMG and drag ajzakomator into Applications. |
| **Mac with an Intel processor** | `ajzakomator-<version>-mac-x64.dmg` | **Recommended for Intel Macs.** Open the DMG and drag ajzakomator into Applications. |
| **Mac, ZIP alternative** | `ajzakomator-<version>-mac-arm64.zip` or `…-mac-x64.zip` | Extract the ZIP and move the app into Applications. Choose the same architecture as above. |

On a Mac, open **Apple menu → About This Mac**: **Chip: Apple M…** means Apple Silicon (`arm64`); **Processor: Intel…** means Intel (`x64`). macOS updates are installed manually by replacing the app with a newer download.

Portable means **no installer**, not that all data stays beside the executable: projects, settings and history still use the app's local data directory.

The app is unsigned on Windows; macOS packages use an ad-hoc signature and are not notarized. Windows may show SmartScreen; macOS may require **System Settings → Privacy & Security → Open Anyway**.

`latest.yml`, `latest-mac.yml` and `.blockmap` are update metadata, not installers. `SHA256SUMS.txt` contains download checksums.

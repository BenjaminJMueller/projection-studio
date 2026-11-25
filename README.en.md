# Projection Studio

[Deutsch](README.md) · English

Projection Studio is a tool for 3D projection mapping on macOS and Windows. It determines the pose and optics of each projector from a few point correspondences between a 3D model (OBJ) and the real projected image. On that basis it computes blend masks with brightness compensation, allows fine correction with a grid and freely placed points, and either plays the result itself or hands it over to TouchDesigner.

![Calibrate](docs/screenshots/02-kalibriert.png)

> **Beta.** Projection Studio grew out of one specific installation and has been tried there, but hardly anywhere else. Bugs and gaps are likely, see [Features and limits](#features-and-limits). If it still helps someone with their own project, I'm glad.

**Download:** [macOS (.dmg)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-mac.dmg) · [Windows, installer (.exe)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-Setup.exe) · [Windows, portable (.exe)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-Portable.exe) · [installation notes](#installation)

The interface is in German by default. Switch to English under *View → Language* (Ansicht → Sprache) or in the help popover (?).

## Background

Projection Studio was created for teaching. The starting point was an installation on a vaulted ceiling, driven by TouchDesigner:

- 8 × Epson EB-535W (short throw), projecting via floor mirrors, image flipped in the projector
- large vertical lens offset, 4 projectors in an inner ring around a central column, 4 in an outer ring
- fed from one computer over 2 × 4K, each output split to 4 projectors by a video wall controller (LogiLink HD0054)
- playback of video from 2K upward across all projectors

For teaching, these were the only projectors available. They are rather unsuited to a vaulted ceiling: short-throw lenses with strong distortion towards the edges, a lens offset that puts the whole image on one side of the lens axis, and the detour via mirrors on the floor. The mirrors are needed because the projectors must not be tilted: according to the [user's guide](https://download.epson.com.sg/manuals/EB-535W_User%20Guide.pdf) (section *Installing the Projector*), the projector is to be placed level and parallel to the screen, must not be used on its side, and wall or ceiling mounting requires a dedicated mount. Pointing the projector steeply up at the ceiling is not intended. So the projectors sit level and a mirror directs the image upwards. Projectors with lens shift and a suitable focal length would have made many things easier. So a solution had to be found that works with the equipment at hand.

The software is not tied to this setup. Any geometry available as OBJ can be used. The vault is included as a demo.

## Existing tools

There are a number of established tools for projection mapping, among them:

- **camSchnappr** and **Stoner** as TouchDesigner components (camera calibration from point pairs, and 2D warping)
- **Kantan Mapper** in TouchDesigner for planar mapping
- **MadMapper**, **Resolume Arena**, **HeavyM** and **Millumin** for mapping and playback, mostly on flat surfaces and simple geometry
- media servers such as **disguise**, **Pixera** and **Watchout**, which cover 3D calibration, blending and playback for large productions
- camera-based auto-calibration, for example from **VIOSO** or **scalable display technologies**

## Why a separate tool

None of these fitted the setup above well. With camSchnappr, calibration was time-consuming and hard to reproduce. The distinctive points in the vault lie close together, and without assumptions about the optics the solution became unstable with such points. There was no independent view in which to judge the result. MadMapper did not reach a usable result with mirrors, lens offset and the vault. Media servers and camera-based systems can do this, but are tied to their own hardware and licences and are not appropriate for a teaching installation running TouchDesigner.

This led to the requirements for this tool:

- a calibration that stays stable with few, awkwardly placed points, because lens, lens offset and approximate position enter as prior knowledge
- direct feedback in a 3D view and on the projectors, so it is clear what the solution does
- blending, fine correction and test patterns in one place, without extra components
- a hand-over to TouchDesigner that fits into existing networks
- its own playback, so the installation can run without TouchDesigner
- runs on an ordinary computer under macOS and Windows, understandable for students without prior experience

## Technical approach

**Calibration.** Each projector is modelled as a pinhole camera with 9 parameters (rotation, position, focal length, principal point). The solution is a MAP estimate: reprojection error in pixels plus weighted deviations from the lens and position priors, minimised with Levenberg-Marquardt from several starting poses. Mirrored projection is taken into account. The solver runs in a web worker, so the interface stays responsive. Quality is reported as RMS error, positional uncertainty and the spread of the points across the image.

**Blending.** For each projector the GPU determines which other projectors hit the same surface. Each projector's share follows the irradiance E ∝ cos(angle of incidence) / (distance² · cos³(off-axis angle)), softened towards the image edges and with adjustable gamma. Surfaces beyond a limit angle can be excluded. Custom masks with soft edges are multiplied in.

**Fine correction.** Two layers per projector. A grid with 2 × 2 to 33 × 33 control points, columns and rows chosen separately, interpolated bicubically (Hermite). Without further edits this equals Catmull-Rom; optionally Bézier handles can be dragged at each grid point to bend the lines. On top come freely placed points anywhere in the image. Each acts through a Wendland kernel with limited reach, and the weights are solved so that every point hits its target exactly. A newly placed point pins the image in place until it is dragged. If the image folds over because of too strong corrections, the app warns.

For output the mapping is inverted: for every output pixel its source position, using Newton's method. In the app this happens in a background thread as a lookup table (coarse while dragging, then 480 × 270 samples, error below 0.2 px) that the GPU interpolates linearly. The cost per frame therefore does not depend on the number of points. For TouchDesigner a GLSL shader is generated with the same values as constants, computing the inverse directly. It matches the app to about 0.001 px.

**Output and playback.** One full-screen window per output. Each projector is rendered into its own multisampled render target and then placed into its cell in a single pass together with fine correction and mask. Video is mapped onto the model (top view or model UVs) and can be rotated in 90° steps. All windows follow a shared clock and correct small drift via playback rate, larger drift by seeking.

## Outputs and video wall controllers

The app supports video wall controllers (also called video wall processors) that split one 4K signal into 2 × 2 Full HD signals. In the vault this is one LogiLink HD0054 per output. Comparable devices are made by Matrox (QuadHead2Go for 2 × 2 or 4 side by side, TripleHead2Go for 3 side by side), Datapath, StarTech and Lindy, among others.

Reasons for this approach:

- **More projectors on one computer.** Typical graphics cards have four outputs, often fewer. With two controllers, eight projectors run from two outputs.
- **Same frame timing.** The four projectors on one controller receive their images from one shared 4K frame.
- **Simple on the software side.** To the operating system each controller is a single 4K display. The app opens one full-screen window on it and places the four projector images into the cells.

Under *Set up* the controller mode is chosen per output: *2 × 2*, *2 side by side*, *2 stacked*, *3 side by side*, *4 side by side* or *4 stacked*, or *1 projector* when a projector is connected directly. The quick choice *Direct, one per output* creates up to four HDMI outputs with one projector each, *Via controller* four per output. The projectors of that output are then assigned to the cells in order. If the display resolution does not match the mode, a hint appears next to it. On the controller itself, use the plain mode without bezel correction; overlap and blending are handled by the app.

Displays are assigned from a menu. Outputs open borderless and full screen on the chosen display, on macOS and Windows. The assignment is kept after unplugging or a change of resolution.

For calibration there is also an optional **test output**. It always shows the currently selected projector full frame, handy when connecting one projector at a time for setup. A permanently connected projector gets a normal HDMI output with *1 projector* instead. With the *Mouse follows* option (mouse icon in the 3D view, switch under *Calibrate*), the mouse pointer lands right on the new point on the projector after a click in the model, and on the projector's image when switching projectors, on the test output or in the right cell of the controller. To assign projectors to cells: under *Set up → Displays* select a projector on the left and click its cell, then the next one is up.

## Workflow

1. **Set up.** Load the model, enable projectors, set lens, mirror, resolution, output and cell.
2. **Calibrate.** Select a projector, click distinctive points in the model and hit them in the projected image, with the mouse on the projector, in the preview or with the arrow keys (1 px, with ⇧ 10 px). Or use a camera and test patterns (see below). Compensate remaining errors in the *Fine correction* tab.
3. **Blend.** Compute masks, adjust the limit angle and transitions, draw custom masks.
4. **Output.** Test patterns or a video playlist on the projectors, audio to the speakers, room tuning, export or live link to TouchDesigner.

<p>
  <img src="docs/screenshots/04-blending.png" width="49%" alt="Blend">
  <img src="docs/screenshots/09-feinkorrektur.png" width="49%" alt="Fine correction">
</p>

Projects are saved automatically, and every step can be undone. On first launch an introduction walks through the setup and offers to start with the demo. The screenshots show the German interface.

## Multiple computers

If one computer's outputs are not enough, other computers on the same network can take over individual outputs.

1. Start the app on all computers. Under *Set up → Multiple computers* choose *Main computer* at the operator's desk and *Output computer* on the others.
2. Output computers find the main computer by themselves (when there is exactly one on the network). Otherwise enter its address by hand. The choice is kept after a restart; an output computer then reconnects by itself.
3. On the main computer, under *Displays*, choose the computer and its display for each output.

The project, masks and every change go live to the output computers. Model and videos are copied once (cache in the app's user folder); until then videos are streamed over the network. Playback runs on a shared clock: each output computer continuously measures its clock offset to the main computer (like NTP) and aligns its videos to it.

**Precise sync** (Output → Playback, off by default): each output measures for every video frame when it actually reaches the screen and corrects from that instead of estimating. Costs a few calculations per frame. When on, a delay in ms can be set per HDMI output to compensate fixed differences (e.g. a projector with longer image processing). To adjust: show the edges pattern, play fast motion and change the delay until the edge is steady. Measured in the test VM (`test/e2e/sync-measure.mjs`): the offset to the clock varies between about 7 and 24 ms without, and stays within about 2 ms with; not yet measured on real hardware.

Limits: without hardware genlock the computers can be up to about one frame apart, which can be visible at blend edges with fast motion. Sound only comes from the main computer. Wired LAN is recommended. The app uses TCP 47810, UDP 47811 and TCP 47812 and only accepts connections from the local network, without a password. On first start macOS asks on each computer whether the app may find devices on the local network: choose *Allow* (later under System Settings → Privacy & Security → Local Network). If the macOS firewall is on, the main computer shows an *Allow …* button. On Windows the firewall asks on first start. After an app update macOS may ask again, because the app is not notarised by Apple. Tested on Linux and on a macOS 26 machine at GitHub (two app instances over the LAN address, firewall on), not yet with two separate computers.

## Features and limits

| | |
|---|---|
| Projectors | up to 16 per project, each can be disabled, freely named groups (e.g. inner ring, outer ring) |
| Outputs | up to 4 HDMI outputs (A to D), each with one directly connected projector or a video wall controller, plus 1 optional test output. Outputs can live on other computers on the network. |
| Controller modes | *1 projector*, *2 × 2*, *2 side by side*, *2 stacked*, *3 side by side*, *4 side by side*, *4 stacked*, *3 × 2*, *3 × 3*. All cells of an output have the same size. |
| Resolution per projector | 1920 × 1080, 1920 × 1200, 1280 × 800, 1280 × 720, 1024 × 768, 3840 × 2160 or the native resolution of the projector type (resolution of the signal) |
| 3D model | OBJ only; materials and textures are ignored. The demo has about 16,000 triangles; much larger models are untested. |
| Projector types | database of verified datasheet values (Epson EB-535W, BenQ MW632ST, Optoma GT1080HDR, Epson EB-L1050U, Panasonic PT-VMZ60), custom types from a datasheet (native resolution, throw ratio, zoom, fixed offset or lens shift), plus generic presets. Lens distortion is not modelled; fine correction compensates the rest. |
| Calibration | by hand from 4 point pairs (6 well-spread points are ideal) or with a camera and test patterns, see below. Possible points (corners and ridges of the model) are shown in the 3D model. Optionally set the projector's location with a tolerance and the projector's image mode (Normal/16:9, Zoom, Native). |
| Fine correction | grid of 2 to 33 control points per direction, optional Bézier handles, up to 200 free points per projector |
| Masks | automatic blending, custom polygon masks with soft edges |
| Video | playlist, play/pause with the space bar, adjustable frame rate (free, 24, 25, 30, 50, 60), display of the current frame rate. Formats Chromium can play: H.264 and AAC in MP4/MOV, VP8, VP9 and AV1 in WebM/MKV. H.265/HEVC only where the system decodes it in hardware. ProRes, HAP, DXV and image sequences are not supported. A frame may hold briefly between two playlist videos. The achievable resolution depends on decoder and graphics card. |
| Audio | the video's soundtrack on up to 32 speakers, channel routing, master and per-channel levels with meters, selectable audio device, sample rate and buffer size. No ASIO: WASAPI on Windows, Core Audio on macOS. |
| Room tuning | sweep over all speakers at several measuring spots, aligns delay, level and tone (up to 8 filters per speaker) for the whole lying area, can be switched on and off. Microphone: smartphone via QR code on the same Wi-Fi, or a measurement microphone on an audio interface. |
| TouchDesigner | export (JSON, masks as PNG, GLSL shader, Python script) and live link via OSC |
| Languages | German (default), English |
| Systems | macOS 11 or later (Apple Silicon and Intel), Windows 10/11 64-bit; graphics card with WebGL 2 |

Tested in the real installation (November 2026): MacBook Pro with M4 Pro, 8 × Epson EB-535W, two HDMI splitters / video wall controllers LogiLink HD0054 (2 × 2 each). Calibration and playback worked there.

Known limitations:

- The Mac app is not signed or notarised by Apple, so the first launch needs a workaround (see below).
- No automatic updates while the repository is private.
- Performance with 8 projectors on 2 × 4K (let alone 16) has not yet been measured on the target machine. The app shows the frame rate per output.
- *Mouse follows* and switching between displays have not yet been tried on real hardware under macOS and Windows.
- The TouchDesigner integration is tested against a mock of the TD API, and only partly on a real installation.
- Camera calibration and room tuning are tested with simulated camera images and recordings, not yet on the real installation.
- Room tuning with a smartphone: phone microphones are inaccurate below about 100 Hz and above 10 kHz, so only the range in between is corrected. The phone asks once about the self-signed certificate when the page is first opened.
- Flat screens also need a (simple) OBJ model.
- Multiple computers: without genlock up to about one frame of offset between computers, sound only from the main computer. Not yet tried with two separate computers on a network.

## Calibration with a camera

Instead of setting points by hand, a webcam (e.g. Logitech StreamCam) can measure a projector. For each projector, the *Calibrate with camera …* assistant (in *Calibrate*) does this:

1. **Aim.** The projector and an already calibrated neighbour show a checkerboard. The camera is set up firmly so that it sees as much of the projector as possible and part of the neighbour. A sharpness meter with a best-value marker helps with focusing.
2. **Measure.** Exposure, focus and white balance are locked as far as the camera allows. Then both projectors show stripe patterns one after another (Gray code with inverses, about 15 seconds per projector). The neighbour gives the camera position; the projector gives the point pairs for the solver.
3. **Result.** Error, coverage of the projector image and a sharpness map. If the camera does not see everything, add another position; the points of all positions are used together. Camera points can be combined with points set by hand.

Blur is detected from the patterns themselves: fine stripes only have full contrast when camera and projector are in focus, measured at a stripe width that matches the camera distance. If the image is blurry, the camera refocuses briefly and measures again. If that does not help, the assistant pauses, shows the checkerboard and guides you to the focus ring of the projector, with a live meter. Camera movement or lighting changes during the measurement are detected and the measurement is repeated.

Limits: the first projector is calibrated by hand, because the camera needs a calibrated projector as a reference. Errors of the reference carry over to the following projectors. Camera lens distortion is not modelled. How far exposure and focus can be locked depends on camera and system (often limited on macOS); then darken the room. In the simulation on the vaulted ceiling the error was about 0.5 px with two camera positions.

## Installation

Older builds are under [Releases](https://github.com/BenjaminJMueller/projection-studio/releases). The version number is shown in the *Help* menu.

The Mac app is not notarised by Apple, so macOS blocks it on first launch. On macOS 15 and later, open the app once, close the message, then click *Open Anyway* at the bottom of *System Settings → Privacy & Security*. Up to macOS 14, right-click the app → *Open* is enough. The same instructions are in the DMG as a picture and as a *Read me* file. Alternatively, run this once in Terminal:

```sh
xattr -dr com.apple.quarantine "/Applications/Projection Studio.app"
```

On Windows, SmartScreen may complain. Click *More info* and then *Run anyway*.

An auto-updater is built in but switched off, because the app cannot read the releases of a private repository without signing in. To use it, put the address of a publicly reachable `latest.json` under `updateFeed` in `package.json`. The build already produces that file.

## TouchDesigner

Under *Output → TouchDesigner → Export …* choose the folder of the `.toe` file. A folder `kalibrierung/` is created there:

```
kalibrierung/
  kalibrierung.json        cameras of all projectors (position, rotation, FOV, lens shift)
  masken/Px.png            blending and custom masks
  feinkorrektur/Px.frag    shader for a GLSL TOP, if a fine correction is set
  apply_calibration.py     script that applies everything
  osc_callbacks.py         counterpart for the live link
```

Put `apply_calibration.py` into a Text DAT in the same network as the cameras, then *Run Script*. The script sets up each camera (the name is set per projector under *Set up*, default `Kamera_Px`) and then checks by itself that the projection is right. With `SETUP_MASKS = True` at the top of the script, it also inserts mask and fine correction after each Render TOP:

```
Projektion_Px → Blend_Px (× Maske_Px) → Fein_Px (GLSL TOP) → …
```

Running the script a second time only updates what is already there.

For the live link, TouchDesigner needs an OSC In DAT on port 7000 with `osc_callbacks.py` as its Callbacks DAT; details are at the top of that file. Then switch on *Live send* under *Output* in the app. From then on every change goes straight to the cameras.

## Development

With Node.js 22:

```sh
npm install
npm start          # start the app
npm test           # unit tests: solver, export, TD script, OSC, playback, fine correction
npm run test:e2e   # click through the whole app once, screenshots go to test-output/
npm run dist       # build an installer for the current system
```

On Linux without a display, run the E2E test with `xvfb-run -a npm run test:e2e`.

Main folders:

```
src/main/       main process: windows, displays, files, OSC, updates
src/renderer/   interface, 3D view, preview, blending, solver in a worker
src/output/     full-screen window per output (scene, fine correction and mask on the GPU)
src/core/       solver, export, OSC
src/shared/     project format, masks, playback, warp grid, translation
examples/       demo vault
td/             scripts for TouchDesigner
test/           tests and test video
```

## Licence

Private, all rights reserved, see [LICENSE](LICENSE). three.js is MIT-licensed.

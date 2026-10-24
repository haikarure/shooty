# Local inference assets

Downloaded 24 October 2026 from Google's official MediaPipe model storage.
These files are read by the Python backend; the app does not load third-party
scripts or download weights on each phone.

| File | Official source | SHA-256 |
| --- | --- | --- |
| `pose_landmarker_lite.task` | [Pose Landmarker Lite float16 v1](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task) | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` |
| `blaze_face_short_range.tflite` | [BlazeFace short range float16 v1](https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite) | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| `face_detection_yunet_2026may.onnx` | [OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0` |
| `face_recognition_sface_2021dec.onnx` | [OpenCV Zoo SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface) | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

YuNet is MIT; SFace is Apache-2.0. Their upstream license files are preserved as
`YUNET-LICENSE` and `SFACE-LICENSE`. Weights were downloaded from the corresponding
official `media.githubusercontent.com/media/opencv/opencv_zoo/main/models/` paths.
The dynamic-shape May 2026 YuNet export supports the installed OpenCV 5 backend.
The older BlazeFace asset is retained for provenance but the active pipeline now
uses YuNet for face boxes/alignment and SFace for matching. No InsightFace package
or noncommercial InsightFace model is installed.

MediaPipe SDK 1.1.1 is Apache-2.0; its license is installed with the package.
Upstream task descriptions, model cards and usage conditions:
[Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker),
[Face Detector](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector),
[BlazeFace model card](https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20%28Short%20Range%29.pdf).

The test photo `tests/fixtures/vision/pose.jpg` comes from
[Google's public MediaPipe test asset](https://storage.googleapis.com/mediapipe-assets/pose.jpg),
SHA-256 `c8a830ed683c0276d713dd5aeda28f415f10cd6291972084a40d0d8b934ed62b`.
It is a test fixture, not a Shooty product/marketing asset. Browser verification
renders it into a canvas stream; a translated view exercises center headshots.
The resulting screenshots are labeled as fixture tests, not physical-camera evidence.

`portrait.jpg` is another [official public MediaPipe test asset](https://storage.googleapis.com/mediapipe-assets/portrait.jpg),
SHA-256 `a6f11efaa834706db23f275b6115058fa87fc7f14362681e6abe14e82749de3e`.
`tests/generate_vision_fixtures.py` reproducibly crops/upsamples the pose photo for
`selfie-pose.jpg` and pastes the portrait face into the pose scene for
`pose-portrait-composite.jpg`. These are engineering fixtures, not real-world
accuracy evidence. No names or real-world identities are assigned to these faces.

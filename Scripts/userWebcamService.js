// TODO(cleanup): Remove this file — it is dead code (not loaded in index.html).
//   Its functionality is duplicated in app.js (startLocalStream). The DOM IDs
//   (#start, #user-vid) don't match the actual HTML (#btn-start, #local-video).

document.addEventListener("DOMContentLoaded", () => {
  let start = document.getElementById("start");
  let video = document.getElementById("user-vid");
  video.style.cssText =
    "-moz-transform: scale(-1, 1); \
-webkit-transform: scale(-1, 1); -o-transform: scale(-1, 1); \
transform: scale(-1, 1); filter: FlipH;";
  let mediaDevices = navigator.mediaDevices;
  video.muted = true;
  start.addEventListener("click", () => {
    // Accessing the user camera and video.
    mediaDevices
      .getUserMedia({
        video: true,
        audio: true,
      })
      .then((stream) => {
        // Changing the source of video to current stream.
        video.srcObject = stream;
        video.addEventListener("loadedmetadata", () => {
          video.play();
        });
      })
      .catch(alert);
  });
});

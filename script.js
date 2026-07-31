const giftButton = document.querySelector("#giftButton");
const sparkButton = document.querySelector("#sparkButton");
const noteButton = document.querySelector("#noteButton");
const notePanel = document.querySelector("#notePanel");
const closeNote = document.querySelector("#closeNote");
const canvas = document.querySelector("#sky");
const ctx = canvas.getContext("2d");

let stars = [];
let bursts = [];
let opened = false;

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * ratio);
  canvas.height = Math.floor(window.innerHeight * ratio);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  stars = Array.from({ length: Math.min(150, Math.floor(window.innerWidth / 8)) }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: Math.random() * 1.8 + .25,
    a: Math.random() * .8 + .2,
    s: Math.random() * .015 + .005
  }));
}

function drawHeartPath(cx, cy, scale) {
  ctx.beginPath();
  for (let i = 0; i <= Math.PI * 2; i += .05) {
    const x = 16 * Math.sin(i) ** 3;
    const y = -(13 * Math.cos(i) - 5 * Math.cos(2 * i) - 2 * Math.cos(3 * i) - Math.cos(4 * i));
    const px = cx + x * scale;
    const py = cy + y * scale;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

function animate() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  stars.forEach((star) => {
    star.a += star.s;
    if (star.a > 1 || star.a < .18) star.s *= -1;
    ctx.fillStyle = `rgba(255, 245, 212, ${star.a})`;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    ctx.fill();
  });

  if (opened) {
    ctx.save();
    ctx.shadowColor = "rgba(255, 209, 102, .9)";
    ctx.shadowBlur = 18;
    ctx.strokeStyle = "rgba(255, 231, 166, .62)";
    ctx.lineWidth = 2;
    drawHeartPath(window.innerWidth * .5, window.innerHeight * .23, Math.min(window.innerWidth, 900) / 900 * 10);
    ctx.stroke();
    ctx.restore();
  }

  bursts = bursts.filter((burst) => burst.life > 0);
  bursts.forEach((burst) => {
    burst.life -= .018;
    burst.parts.forEach((part) => {
      part.x += part.vx;
      part.y += part.vy;
      part.vy += .018;
      ctx.fillStyle = `hsla(${part.hue}, 100%, 72%, ${Math.max(burst.life, 0)})`;
      ctx.beginPath();
      ctx.arc(part.x, part.y, part.size, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  requestAnimationFrame(animate);
}

function makeBurst(x = window.innerWidth / 2, y = window.innerHeight / 2) {
  const parts = Array.from({ length: 76 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 76;
    const speed = Math.random() * 5 + 2;
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: Math.random() * 3 + 1.2,
      hue: [337, 46, 176, 282][Math.floor(Math.random() * 4)]
    };
  });

  bursts.push({ life: 1, parts });
}

function makeHearts(count = 18) {
  for (let i = 0; i < count; i += 1) {
    const heart = document.createElement("span");
    heart.className = "floating-heart";
    heart.style.left = `${Math.random() * 100}vw`;
    heart.style.top = `${Math.random() * 80 + 12}vh`;
    heart.style.animationDelay = `${Math.random() * .45}s`;
    heart.style.background = Math.random() > .5 ? "var(--rose)" : "var(--gold)";
    document.body.appendChild(heart);
    heart.addEventListener("animationend", () => heart.remove());
  }
}

giftButton.addEventListener("click", () => {
  opened = true;
  document.body.classList.add("opened");
  if (location.hash !== "#open") history.replaceState(null, "", "#open");
  makeBurst(window.innerWidth / 2, window.innerHeight * .42);
  setTimeout(() => makeHearts(24), 260);
});

sparkButton.addEventListener("click", (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  makeBurst(rect.left + rect.width / 2, rect.top + rect.height / 2);
  makeHearts(14);
});

noteButton.addEventListener("click", () => {
  notePanel.classList.add("is-visible");
  makeBurst(window.innerWidth * .5, window.innerHeight * .5);
});

closeNote.addEventListener("click", () => {
  notePanel.classList.remove("is-visible");
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") notePanel.classList.remove("is-visible");
});

window.addEventListener("resize", resizeCanvas);

resizeCanvas();
animate();

if (location.hash === "#open") {
  opened = true;
  document.body.classList.add("opened", "deep-open");
}

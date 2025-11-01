const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
class Node {
    constructor(theta, phi, radius) {
        this.theta = theta;
        this.phi = phi;
        this.radius = radius;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.screenX = 0;
        this.screenY = 0;
        this.brightness = Math.random() * 0.5 + 0.5;
        this.pulseSpeed = Math.random() * 0.02 + 0.01;
        this.pulseOffset = Math.random() * Math.PI * 2;
        this.updatePosition(0);
    }
    updatePosition(rotation) {
        const r = this.radius;
        const adjustedTheta = this.theta + rotation;
        this.x = r * Math.sin(this.phi) * Math.cos(adjustedTheta);
        this.y = r * Math.sin(this.phi) * Math.sin(adjustedTheta);
        this.z = r * Math.cos(this.phi);
        const scale = 300 / (300 + this.z);
        this.screenX = this.x * scale + canvas.width / 2;
        this.screenY = this.y * scale + canvas.height / 2;
        this.scale = scale;
    }
    draw(time) {
        const pulse = Math.sin(time * this.pulseSpeed + this.pulseOffset) * 0.3 + 0.7;
        const distanceFromCenter = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
        const maxDistance = this.radius;
        const centerBrightness = 1 - (distanceFromCenter / maxDistance) * 0.6;
        const size = (2 + pulse * 1) * this.scale;
        const alpha = this.scale * this.brightness * pulse * centerBrightness;
        const gradient = ctx.createRadialGradient(
            this.screenX, this.screenY, 0,
            this.screenX, this.screenY, size * 3
        );
        gradient.addColorStop(0, `rgba(147, 112, 219, ${alpha})`);
        gradient.addColorStop(0.5, `rgba(102, 126, 234, ${alpha * 0.6})`);
        gradient.addColorStop(1, `rgba(102, 126, 234, 0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(this.screenX, this.screenY, size * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(200, 180, 255, ${alpha})`;
        ctx.beginPath();
        ctx.arc(this.screenX, this.screenY, size, 0, Math.PI * 2);
        ctx.fill();
    }
}
const nodes = [];
const numNodes = 100;
const sphereRadius = 150;
for (let i = 0; i < numNodes; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    nodes.push(new Node(theta, phi, sphereRadius));
}
let rotation = 0;
let time = 0;
function drawBrainCPU() {
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const size = 60;
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, size * 2);
    gradient.addColorStop(0, 'rgba(147, 112, 219, 0.9)');
    gradient.addColorStop(0.5, 'rgba(102, 126, 234, 0.6)');
    gradient.addColorStop(1, 'rgba(102, 126, 234, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, size * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 180, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const x1 = centerX + Math.cos(angle) * 20;
        const y1 = centerY + Math.sin(angle) * 20;
        const x2 = centerX + Math.cos(angle) * 40;
        const y2 = centerY + Math.sin(angle) * 40;
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    const pulse = Math.sin(time * 0.03) * 10 + 30;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(centerX, centerY, pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(147, 112, 219, 0.8)';
    ctx.fillRect(centerX - 15, centerY - 15, 30, 30);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1;
    for (let i = -10; i <= 10; i += 5) {
        ctx.beginPath();
        ctx.moveTo(centerX + i, centerY - 15);
        ctx.lineTo(centerX + i, centerY + 15);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(centerX - 15, centerY + i);
        ctx.lineTo(centerX + 15, centerY + i);
        ctx.stroke();
    }
}
function drawConnections() {
    ctx.strokeStyle = 'rgba(102, 126, 234, 0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const dx = nodes[i].x - nodes[j].x;
            const dy = nodes[i].y - nodes[j].y;
            const dz = nodes[i].z - nodes[j].z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (distance < 80) {
                const alpha = (1 - distance / 80) * 0.3;
                ctx.strokeStyle = `rgba(102, 126, 234, ${alpha})`;
                ctx.beginPath();
                ctx.moveTo(nodes[i].screenX, nodes[i].screenY);
                ctx.lineTo(nodes[j].screenX, nodes[j].screenY);
                ctx.stroke();
            }
        }
    }
}
function animate() {
    ctx.fillStyle = 'rgba(10, 10, 26, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    rotation += 0.003;
    time++;
    nodes.forEach(node => node.updatePosition(rotation));
    nodes.sort((a, b) => a.z - b.z);
    drawConnections();
    nodes.forEach(node => node.draw(time));
    drawBrainCPU();
    requestAnimationFrame(animate);
}
animate();
window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
});
let mouseX = 0;
let mouseY = 0;
window.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 0.1;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 0.1;
});

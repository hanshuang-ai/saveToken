---
title: JavaScript核心概念与实战技巧
date: 2021-01-03 00:00:00
tags: [javascript, 事件循环, 正则, dom, 事件处理, 打印]
categories: 前端开发
updated: 2022-09-10 18:00:00
---

# JavaScript核心概念与实战技巧

JavaScript作为前端开发的核心语言，其重要性不言而喻。本文将深入探讨JavaScript的核心概念，包括事件循环、DOM操作、事件处理、正则表达式等，并通过实际案例展示如何在实际开发中应用这些技术。

## 1. JavaScript事件循环机制

### 1.1 单线程与异步编程

JavaScript是单线程语言，这意味着在JS引擎中负责解释和执行JavaScript代码的线程只有一个。为了处理耗时操作而不阻塞主线程，JavaScript引入了异步编程机制。

```javascript
// 同步代码示例
console.log('开始');

function syncTask() {
    console.log('同步任务');
    for (let i = 0; i < 1000000000; i++) {
        // 耗时操作
    }
    console.log('同步任务完成');
}

syncTask();
console.log('结束');

// 输出顺序：开始 -> 同步任务 -> 同步任务完成 -> 结束
```

### 1.2 事件循环详解

事件循环负责收集用户事件、对任务进行排队以便在合适的时候执行回调。它执行所有处于等待中的JavaScript任务（宏任务），然后是微任务，然后再开始下一次循环。

```javascript
// 事件循环示例
console.log('脚本开始');

setTimeout(() => {
    console.log('宏任务：setTimeout');
}, 0);

Promise.resolve().then(() => {
    console.log('微任务：Promise');
});

console.log('脚本结束');

// 输出顺序：
// 脚本开始
// 脚本结束
// 微任务：Promise
// 宏任务：setTimeout
```

### 1.3 宏任务与微任务

```javascript
// 宏任务（Macrotask）
// - setTimeout
// - setInterval
// - setImmediate (Node.js)
// - I/O操作
// - UI渲染

// 微任务（Microtask）
// - Promise.then/catch/finally
// - async/await
// - process.nextTick (Node.js)
// - MutationObserver

// 执行优先级：同步代码 > 微任务 > 宏任务

console.log('1');

setTimeout(() => {
    console.log('2');
    Promise.resolve().then(() => console.log('3'));
}, 0);

new Promise(resolve => {
    console.log('4');
    resolve();
}).then(() => {
    console.log('5');
    setTimeout(() => console.log('6'), 0);
});

console.log('7');

// 输出：1, 4, 7, 5, 2, 3, 6
```

### 1.4 实际应用案例

```javascript
// 实际开发中的异步处理
class DataLoader {
    constructor() {
        this.cache = new Map();
    }

    async loadData(url) {
        // 检查缓存
        if (this.cache.has(url)) {
            console.log('从缓存加载数据');
            return this.cache.get(url);
        }

        console.log('开始加载数据');

        try {
            // 模拟网络请求
            const data = await this.fetchData(url);

            // 缓存数据
            this.cache.set(url, data);

            console.log('数据加载完成');
            return data;
        } catch (error) {
            console.error('数据加载失败:', error);
            throw error;
        }
    }

    fetchData(url) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({ url, data: `数据来自${url}`, timestamp: Date.now() });
            }, 1000);
        });
    }
}

// 使用示例
const loader = new DataLoader();

loader.loadData('https://api.example.com/data1')
    .then(data => console.log('数据1:', data))
    .catch(error => console.error(error));

loader.loadData('https://api.example.com/data2')
    .then(data => console.log('数据2:', data))
    .catch(error => console.error(error));

// 第二次加载相同URL（从缓存）
setTimeout(() => {
    loader.loadData('https://api.example.com/data1')
        .then(data => console.log('数据1（缓存）:', data));
}, 2000);
```

## 2. 页面加载与DOM操作

### 2.1 load vs ready事件

```javascript
// window.onload - 等待所有资源加载完成
window.onload = function() {
    console.log('页面所有资源加载完成');
    // 包括图片、样式表、脚本等
    // 只能绑定一个，多个会被覆盖
};

// DOMContentLoaded - DOM结构加载完成
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM结构加载完成');
    // 不必等待图片等资源
    // 可以绑定多个监听器
});

// jQuery的ready方法
$(document).ready(function() {
    console.log('jQuery ready');
});

// jQuery简化写法
$(function() {
    console.log('jQuery ready简化写法');
});
```

### 2.2 DOM操作最佳实践

```javascript
// 高效的DOM操作
class DOMManager {
    constructor() {
        this.fragment = document.createDocumentFragment();
    }

    // 批量创建元素
    createList(items) {
        const ul = document.createElement('ul');

        // 使用DocumentFragment提高性能
        items.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item;
            li.className = 'list-item';

            // 添加事件监听
            li.addEventListener('click', this.handleItemClick.bind(this));

            this.fragment.appendChild(li);
        });

        ul.appendChild(this.fragment);
        return ul;
    }

    // 事件委托
    setupEventDelegate(container) {
        container.addEventListener('click', (event) => {
            if (event.target.classList.contains('list-item')) {
                this.handleItemClick(event);
            }
        });
    }

    // 懒加载图片
    lazyLoadImages() {
        const images = document.querySelectorAll('img[data-src]');

        if ('IntersectionObserver' in window) {
            const imageObserver = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        imageObserver.unobserve(img);
                    }
                });
            });

            images.forEach(img => imageObserver.observe(img));
        } else {
            // 兼容性处理
            this.lazyLoadFallback(images);
        }
    }

    lazyLoadFallback(images) {
        const lazyLoad = () => {
            images.forEach(img => {
                if (img.getBoundingClientRect().top <= window.innerHeight &&
                    img.getBoundingClientRect().bottom >= 0 &&
                    getComputedStyle(img).display !== 'none') {
                    img.src = img.dataset.src;
                    img.removeAttribute('data-src');
                }
            });
        };

        window.addEventListener('scroll', lazyLoad);
        window.addEventListener('resize', lazyLoad);
        lazyLoad(); // 初始检查
    }

    handleClick(event) {
        console.log('点击项目:', event.target.textContent);
    }
}

// 使用示例
const domManager = new DOMManager();

// 等待DOM加载完成
document.addEventListener('DOMContentLoaded', function() {
    const items = ['项目1', '项目2', '项目3', '项目4', '项目5'];
    const listContainer = document.getElementById('list-container');

    const list = domManager.createList(items);
    listContainer.appendChild(list);

    // 设置懒加载
    domManager.lazyLoadImages();
});
```

## 3. 事件处理与事件委托

### 3.1 addEventListener详解

```javascript
// addEventListener语法
// element.addEventListener(event, handler, options)

// 基本用法
const button = document.getElementById('myButton');
button.addEventListener('click', function(event) {
    console.log('按钮被点击了');
    console.log('事件对象:', event);
});

// 第三个参数详解
button.addEventListener('click', function(event) {
    console.log('捕获阶段触发');
}, true); // true表示在捕获阶段触发

button.addEventListener('click', function(event) {
    console.log('冒泡阶段触发');
}, false); // false或不传表示在冒泡阶段触发（默认）

// 使用选项对象
button.addEventListener('click', function(event) {
    console.log('点击事件');
}, {
    capture: false,    // 是否在捕获阶段触发
    once: true,       // 只触发一次
    passive: true     // 被动监听器，提高滚动性能
});
```

### 3.2 事件委托实战

```javascript
// 大型列表的事件委托
class ListManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.items = [];
        this.init();
    }

    init() {
        // 使用事件委托处理所有列表项的点击
        this.container.addEventListener('click', (event) => {
            const listItem = event.target.closest('.list-item');

            if (listItem) {
                this.handleItemClick(listItem, event);
            }
        });

        // 处理删除按钮点击
        this.container.addEventListener('click', (event) => {
            if (event.target.classList.contains('delete-btn')) {
                event.stopPropagation(); // 阻止冒泡
                this.handleDeleteClick(event.target);
            }
        });
    }

    addItem(text) {
        const item = {
            id: Date.now(),
            text: text,
            completed: false
        };

        this.items.push(item);
        this.renderItem(item);
    }

    renderItem(item) {
        const li = document.createElement('li');
        li.className = 'list-item';
        li.dataset.id = item.id;

        li.innerHTML = `
            <span class="item-text ${item.completed ? 'completed' : ''}">${item.text}</span>
            <button class="delete-btn">删除</button>
        `;

        this.container.appendChild(li);
    }

    handleItemClick(element, event) {
        const id = parseInt(element.dataset.id);
        const item = this.items.find(i => i.id === id);

        if (item) {
            item.completed = !item.completed;
            element.classList.toggle('completed');
        }
    }

    handleDeleteClick(button) {
        const listItem = button.closest('.list-item');
        const id = parseInt(listItem.dataset.id);

        // 从数据中删除
        this.items = this.items.filter(i => i.id !== id);

        // 从DOM中删除
        listItem.remove();
    }
}

// 使用示例
const listManager = new ListManager('myList');
listManager.addItem('学习JavaScript');
listManager.addItem('掌握事件循环');
listManager.addItem('理解DOM操作');
```

### 3.3 自定义事件

```javascript
// 创建和使用自定义事件
class EventBus {
    constructor() {
        this.events = {};
    }

    // 订阅事件
    on(eventName, callback) {
        if (!this.events[eventName]) {
            this.events[eventName] = [];
        }
        this.events[eventName].push(callback);
    }

    // 发布事件
    emit(eventName, data) {
        if (this.events[eventName]) {
            this.events[eventName].forEach(callback => {
                callback(data);
            });
        }
    }

    // 取消订阅
    off(eventName, callback) {
        if (this.events[eventName]) {
            this.events[eventName] = this.events[eventName].filter(cb => cb !== callback);
        }
    }
}

// 使用示例
const eventBus = new EventBus();

// 订阅事件
eventBus.on('userLogin', (userData) => {
    console.log('用户登录:', userData);
    updateUserInterface(userData);
});

eventBus.on('dataUpdate', (newData) => {
    console.log('数据更新:', newData);
    refreshDataDisplay(newData);
});

// 发布事件
// 模拟用户登录
eventBus.emit('userLogin', {
    id: 1,
    name: '张三',
    email: 'zhangsan@example.com'
});

// 模拟数据更新
eventBus.emit('dataUpdate', {
    timestamp: Date.now(),
    data: [1, 2, 3, 4, 5]
});
```

## 4. 正则表达式实战

### 4.1 基础正则表达式

```javascript
// 常用正则表达式模式
const patterns = {
    // 数字
    integer: /^\d+$/,
    float: /^\d+\.\d+$/,
    number: /^\d+(\.\d+)?$/,

    // 字符串
    email: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    phone: /^1[3-9]\d{9}$/,
    url: /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/,

    // 身份证
    idCard: /^[1-9]\d{5}(18|19|20)\d{2}((0[1-9])|(1[0-2]))(([0-2][1-9])|10|20|30|31)\d{3}[0-9Xx]$/,

    // 密码强度
    password: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d@$!%*?&]{8,}$/,

    // 中文
    chinese: /^[\u4e00-\u9fa5]+$/,

    // 空白字符
    whitespace: /^\s*$/,

    // HTML标签
    htmlTag: /<[^>]*>/g
};

// 验证函数
function validate(patternName, value) {
    const pattern = patterns[patternName];
    if (!pattern) {
        console.error(`未找到模式: ${patternName}`);
        return false;
    }

    return pattern.test(value);
}

// 使用示例
console.log('邮箱验证:', validate('email', 'user@example.com')); // true
console.log('手机验证:', validate('phone', '13812345678')); // true
console.log('身份证验证:', validate('idCard', '11010119900307234X')); // true
```

### 4.2 高级正则应用

```javascript
// CSS单位转换工具
class CSSConverter {
    constructor() {
        this.variables = new Map();
    }

    // 将vh单位转换为CSS变量
    convertVHToVariable(cssText, variableName = '--heightsize') {
        // 匹配数字（整数或小数）+ vh
        const vhRegex = /(\d+\.\d+|\d+)vh/g;

        return cssText.replace(vhRegex, (match, number) => {
            return `calc(${variableName} * ${number})`;
        });
    }

    // 提取CSS变量
    extractVariables(cssText) {
        const varRegex = /--([a-zA-Z0-9-_]+):\s*([^;]+);/g;
        let match;

        while ((match = varRegex.exec(cssText)) !== null) {
            this.variables.set(match[1], match[2].trim());
        }

        return this.variables;
    }

    // 替换CSS变量引用
    replaceVariableReferences(cssText) {
        const refRegex = /var\(--([a-zA-Z0-9-_]+)\)/g;

        return cssText.replace(refRegex, (match, varName) => {
            return this.variables.get(varName) || match;
        });
    }

    // 处理完整的CSS
    processCSS(cssText) {
        // 提取变量
        this.extractVariables(cssText);

        // 转换vh单位
        let processedCSS = this.convertVHToVariable(cssText);

        // 可选：替换变量引用（调试用）
        // processedCSS = this.replaceVariableReferences(processedCSS);

        return processedCSS;
    }
}

// 使用示例
const converter = new CSSConverter();

const cssText = `
:root {
    --heightsize: 1vh;
}

.container {
    height: 100vh;
    margin-top: 15vh;
    padding: 2.5vh;
    font-size: calc(var(--heightsize) * 3);
}

.element {
    width: 50vh;
    margin-bottom: 5.5vh;
}
`;

const processedCSS = converter.processCSS(cssText);
console.log('处理后的CSS:', processedCSS);

// 输出：
// :root {
//     --heightsize: 1vh;
// }
//
// .container {
//     height: calc(--heightsize * 100);
//     margin-top: calc(--heightsize * 15);
//     padding: calc(--heightsize * 2.5);
//     font-size: calc(var(--heightsize) * 3);
// }
//
// .element {
//     width: calc(--heightsize * 50);
//     margin-bottom: calc(--heightsize * 5.5);
// }
```

### 4.3 文本处理工具

```javascript
// 文本处理工具类
class TextProcessor {
    // 高亮关键词
    highlightKeywords(text, keywords, className = 'highlight') {
        if (!keywords || keywords.length === 0) return text;

        // 创建正则表达式，忽略大小写
        const regex = new RegExp(`(${keywords.join('|')})`, 'gi');

        return text.replace(regex, `<span class="${className}">$1</span>`);
    }

    // 提取链接
    extractLinks(text) {
        const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;

        return text.match(urlRegex) || [];
    }

    // 验证和格式化手机号
    formatPhoneNumber(phoneNumber) {
        // 移除所有非数字字符
        const cleaned = phoneNumber.replace(/\D/g, '');

        // 验证是否为有效的中国手机号
        if (!/^1[3-9]\d{9}$/.test(cleaned)) {
            return null;
        }

        // 格式化为 138-1234-5678
        return cleaned.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    }

    // 提取Emoji
    extractEmojis(text) {
        const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;

        return text.match(emojiRegex) || [];
    }

    // 清理HTML标签
    stripHTML(html) {
        return html.replace(/<[^>]*>/g, '');
    }

    // 截断文本
    truncateText(text, maxLength, suffix = '...') {
        if (text.length <= maxLength) return text;

        return text.substring(0, maxLength - suffix.length) + suffix;
    }
}

// 使用示例
const processor = new TextProcessor();

const text = '这是一个包含链接 https://www.example.com 和emoji 😊 的文本。还有手机号：13812345678';

console.log('提取链接:', processor.extractLinks(text));
console.log('格式化手机号:', processor.formatPhoneNumber('138-1234-5678'));
console.log('提取emoji:', processor.extractEmojis(text));
console.log('清理HTML:', processor.stripHTML('<p>这是<strong>HTML</strong>文本</p>'));
console.log('截断文本:', processor.truncateText('这是一个很长的文本，需要被截断处理', 15));
```

## 5. 屏幕方向检测与响应式处理

### 5.1 横竖屏检测

```javascript
// 屏幕方向管理器
class OrientationManager {
    constructor() {
        this.currentOrientation = this.getOrientation();
        this.callbacks = [];
        this.init();
    }

    init() {
        // 监听屏幕方向变化
        window.addEventListener('orientationchange', this.handleOrientationChange.bind(this));

        // 监听窗口大小变化（备用方案）
        window.addEventListener('resize', this.handleResize.bind(this));

        // 初始检测
        this.checkOrientation();
    }

    getOrientation() {
        // 优先使用orientation API
        if (window.orientation !== undefined) {
            return Math.abs(window.orientation) === 90 ? 'landscape' : 'portrait';
        }

        // 备用方案：根据屏幕宽高比判断
        return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
    }

    handleOrientationChange() {
        setTimeout(() => {
            this.checkOrientation();
        }, 100); // 延迟确保方向变化完成
    }

    handleResize() {
        this.checkOrientation();
    }

    checkOrientation() {
        const newOrientation = this.getOrientation();

        if (newOrientation !== this.currentOrientation) {
            this.currentOrientation = newOrientation;
            this.notifyCallbacks(newOrientation);
        }
    }

    // 添加方向变化回调
    onChange(callback) {
        this.callbacks.push(callback);

        // 返回取消订阅函数
        return () => {
            this.callbacks = this.callbacks.filter(cb => cb !== callback);
        };
    }

    // 通知所有回调
    notifyCallbacks(orientation) {
        this.callbacks.forEach(callback => {
            try {
                callback(orientation, this.currentOrientation);
            } catch (error) {
                console.error('方向变化回调执行失败:', error);
            }
        });
    }

    // 当前是否为横屏
    isLandscape() {
        return this.currentOrientation === 'landscape';
    }

    // 当前是否为竖屏
    isPortrait() {
        return this.currentOrientation === 'portrait';
    }
}

// 横竖屏提示组件
class OrientationPrompt {
    constructor(requiredOrientation = 'landscape') {
        this.requiredOrientation = requiredOrientation;
        this.promptElement = null;
        this.isVisible = false;
        this.orientationManager = new OrientationManager();

        this.init();
    }

    init() {
        // 监听方向变化
        this.orientationManager.onChange((orientation) => {
            this.updateVisibility();
        });

        // 初始检查
        this.updateVisibility();
    }

    createPrompt() {
        if (this.promptElement) return;

        this.promptElement = document.createElement('div');
        this.promptElement.className = 'orientation-prompt';
        this.promptElement.innerHTML = `
            <div class="orientation-prompt-content">
                <div class="orientation-icon">📱</div>
                <h3>请使用${this.requiredOrientation === 'landscape' ? '横屏' : '竖屏'}模式</h3>
                <p>为了获得最佳体验，请将设备旋转为${this.requiredOrientation === 'landscape' ? '横屏' : '竖屏'}模式</p>
            </div>
        `;

        // 添加样式
        this.promptElement.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;

        document.body.appendChild(this.promptElement);
    }

    updateVisibility() {
        const currentOrientation = this.orientationManager.getOrientation();
        const needShowPrompt = currentOrientation !== this.requiredOrientation;

        if (needShowPrompt && !this.isVisible) {
            this.show();
        } else if (!needShowPrompt && this.isVisible) {
            this.hide();
        }
    }

    show() {
        this.createPrompt();
        this.isVisible = true;
        document.body.style.visibility = 'hidden';
    }

    hide() {
        if (this.promptElement) {
            this.promptElement.remove();
            this.promptElement = null;
        }
        this.isVisible = false;
        document.body.style.visibility = 'visible';
    }

    destroy() {
        this.hide();
        // 清理事件监听器等
    }
}

// 使用示例
// 游戏页面需要横屏
const gameOrientationPrompt = new OrientationPrompt('landscape');

// 阅读页面需要竖屏
const readingOrientationPrompt = new OrientationPrompt('portrait');
```

## 6. 网页打印功能

### 6.1 基础打印功能

```javascript
// 打印管理器
class PrintManager {
    constructor() {
        this.printStyles = null;
        this.originalTitle = document.title;
    }

    // 打印整个页面
    printPage() {
        window.print();
    }

    // 打印特定内容
    printElement(elementId, options = {}) {
        const element = document.getElementById(elementId);
        if (!element) {
            console.error(`元素 #${elementId} 不存在`);
            return;
        }

        // 创建打印容器
        const printContainer = document.createElement('div');
        printContainer.className = 'print-container';

        // 克隆要打印的元素
        const clonedElement = element.cloneNode(true);
        printContainer.appendChild(clonedElement);

        // 创建打印样式
        this.createPrintStyles(options);

        // 临时添加到页面
        document.body.appendChild(printContainer);

        // 设置打印标题
        if (options.title) {
            document.title = options.title;
        }

        // 触发打印
        window.print();

        // 清理
        setTimeout(() => {
            document.body.removeChild(printContainer);
            this.removePrintStyles();
            document.title = this.originalTitle;
        }, 100);
    }

    // 创建打印样式
    createPrintStyles(options = {}) {
        const defaultStyles = `
            @media print {
                body * {
                    visibility: hidden;
                }

                .print-container,
                .print-container * {
                    visibility: visible;
                }

                .print-container {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 100%;
                }

                @page {
                    margin: ${options.margin || '1cm'};
                    size: ${options.pageSize || 'A4'};
                    orientation: ${options.orientation || 'portrait'};
                }

                .no-print {
                    display: none !important;
                }

                .print-break-before {
                    page-break-before: always;
                }

                .print-break-after {
                    page-break-after: always;
                }

                .print-break-inside-avoid {
                    page-break-inside: avoid;
                }
            }
        `;

        this.printStyles = document.createElement('style');
        this.printStyles.textContent = defaultStyles;
        document.head.appendChild(this.printStyles);
    }

    // 移除打印样式
    removePrintStyles() {
        if (this.printStyles) {
            document.head.removeChild(this.printStyles);
            this.printStyles = null;
        }
    }

    // 打印表格数据
    printTable(data, headers, options = {}) {
        const table = document.createElement('table');
        table.className = 'print-table';

        // 创建表头
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header.text || header;
            th.style.cssText = 'border: 1px solid #ddd; padding: 8px; background: #f5f5f5;';
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // 创建表体
        const tbody = document.createElement('tbody');

        data.forEach(row => {
            const tr = document.createElement('tr');

            headers.forEach(header => {
                const td = document.createElement('td');
                const value = typeof row === 'object' ? row[header.key || header] : row;
                td.textContent = value || '';
                td.style.cssText = 'border: 1px solid #ddd; padding: 8px;';
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);

        // 添加基础样式
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        `;

        // 临时添加到页面
        const container = document.createElement('div');
        container.className = 'print-container';
        container.appendChild(table);
        document.body.appendChild(container);

        // 打印
        this.createPrintStyles(options);
        window.print();

        // 清理
        setTimeout(() => {
            document.body.removeChild(container);
            this.removePrintStyles();
        }, 100);
    }

    // 打印图表（假设使用Canvas）
    printChart(canvasId, options = {}) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) {
            console.error(`Canvas #${canvasId} 不存在`);
            return;
        }

        // 创建图片
        const img = document.createElement('img');
        img.src = canvas.toDataURL('image/png');
        img.style.cssText = `
            max-width: 100%;
            height: auto;
            display: block;
            margin: 20px auto;
        `;

        // 创建打印容器
        const container = document.createElement('div');
        container.className = 'print-container';

        if (options.title) {
            const title = document.createElement('h2');
            title.textContent = options.title;
            title.style.cssText = 'text-align: center; margin-bottom: 20px;';
            container.appendChild(title);
        }

        container.appendChild(img);

        document.body.appendChild(container);

        // 打印
        this.createPrintStyles(options);
        window.print();

        // 清理
        setTimeout(() => {
            document.body.removeChild(container);
            this.removePrintStyles();
        }, 100);
    }
}

// 使用示例
const printManager = new PrintManager();

// 打印整个页面
document.getElementById('printPageBtn').addEventListener('click', () => {
    printManager.printPage();
});

// 打印特定区域
document.getElementById('printSectionBtn').addEventListener('click', () => {
    printManager.printElement('content-section', {
        title: '内容区域打印',
        pageSize: 'A4',
        margin: '2cm'
    });
});

// 打印表格
document.getElementById('printTableBtn').addEventListener('click', () => {
    const data = [
        { name: '张三', age: 25, city: '北京' },
        { name: '李四', age: 30, city: '上海' },
        { name: '王五', age: 28, city: '广州' }
    ];

    const headers = [
        { text: '姓名', key: 'name' },
        { text: '年龄', key: 'age' },
        { text: '城市', key: 'city' }
    ];

    printManager.printTable(data, headers, {
        title: '用户信息表',
        orientation: 'landscape'
    });
});
```

### 6.2 高级打印功能

```javascript
// 高级打印功能：支持复杂布局
class AdvancedPrintManager extends PrintManager {
    // 打印多页文档
    printDocument(sections, options = {}) {
        const container = document.createElement('div');
        container.className = 'print-document';

        sections.forEach((section, index) => {
            const sectionElement = this.createSection(section, index);
            container.appendChild(sectionElement);
        });

        // 添加文档样式
        container.style.cssText = `
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
        `;

        document.body.appendChild(container);

        // 创建高级打印样式
        this.createAdvancedPrintStyles(options);

        // 设置页面标题
        if (options.title) {
            document.title = options.title;
        }

        window.print();

        // 清理
        setTimeout(() => {
            document.body.removeChild(container);
            this.removePrintStyles();
            document.title = this.originalTitle;
        }, 100);
    }

    createSection(section, index) {
        const sectionElement = document.createElement('div');
        sectionElement.className = 'document-section';

        if (index > 0) {
            sectionElement.classList.add('print-break-before');
        }

        // 添加标题
        if (section.title) {
            const title = document.createElement('h2');
            title.textContent = section.title;
            title.style.cssText = `
                color: #2c3e50;
                border-bottom: 2px solid #3498db;
                padding-bottom: 10px;
                margin-bottom: 20px;
                ${index > 0 ? 'page-break-before: always;' : ''}
            `;
            sectionElement.appendChild(title);
        }

        // 添加内容
        if (section.content) {
            const content = document.createElement('div');
            content.className = 'section-content';
            content.innerHTML = section.content;
            sectionElement.appendChild(content);
        }

        // 添加表格
        if (section.table) {
            const table = this.createTable(section.table.data, section.table.headers);
            sectionElement.appendChild(table);
        }

        // 添加图表
        if (section.chart) {
            const chart = this.createChartImage(section.chart);
            sectionElement.appendChild(chart);
        }

        return sectionElement;
    }

    createTable(data, headers) {
        const table = document.createElement('table');
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
            font-size: 12px;
        `;

        // 表头
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.cssText = 'background: #f8f9fa;';

        headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header.text || header;
            th.style.cssText = `
                border: 1px solid #dee2e6;
                padding: 8px;
                text-align: left;
                font-weight: 600;
            `;
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // 表体
        const tbody = document.createElement('tbody');

        data.forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.style.cssText = index % 2 === 0 ? 'background: #ffffff;' : 'background: #f8f9fa;';

            headers.forEach(header => {
                const td = document.createElement('td');
                const value = typeof row === 'object' ? row[header.key || header] : row;
                td.textContent = value || '';
                td.style.cssText = `
                    border: 1px solid #dee2e6;
                    padding: 8px;
                `;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        return table;
    }

    createChartImage(chartOptions) {
        const container = document.createElement('div');
        container.style.cssText = `
            text-align: center;
            margin: 20px 0;
            page-break-inside: avoid;
        `;

        if (chartOptions.title) {
            const title = document.createElement('h4');
            title.textContent = chartOptions.title;
            title.style.cssText = 'margin-bottom: 10px; color: #2c3e50;';
            container.appendChild(title);
        }

        const img = document.createElement('img');
        img.src = chartOptions.dataUrl;
        img.style.cssText = `
            max-width: 100%;
            height: auto;
            border: 1px solid #dee2e6;
        `;

        container.appendChild(img);
        return container;
    }

    createAdvancedPrintStyles(options) {
        const styles = `
            @media print {
                body * {
                    visibility: hidden;
                }

                .print-document,
                .print-document * {
                    visibility: visible;
                }

                .print-document {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 100%;
                    padding: 20px;
                    box-sizing: border-box;
                }

                .document-section {
                    margin-bottom: 30px;
                }

                .section-content {
                    margin-bottom: 20px;
                    text-align: justify;
                }

                .section-content p {
                    margin: 10px 0;
                    text-indent: 2em;
                }

                @page {
                    margin: ${options.margin || '1.5cm'};
                    size: ${options.pageSize || 'A4'};
                    orientation: ${options.orientation || 'portrait'};
                }

                h2 {
                    color: #2c3e50 !important;
                    font-size: 18px !important;
                }

                h4 {
                    color: #34495e !important;
                    font-size: 14px !important;
                }

                table {
                    page-break-inside: avoid;
                }

                .print-break-before {
                    page-break-before: always;
                }

                .print-break-after {
                    page-break-after: always;
                }

                .print-break-inside-avoid {
                    page-break-inside: avoid;
                }
            }
        `;

        this.printStyles = document.createElement('style');
        this.printStyles.textContent = styles;
        document.head.appendChild(this.printStyles);
    }
}

// 使用示例
const advancedPrintManager = new AdvancedPrintManager();

document.getElementById('printDocumentBtn').addEventListener('click', () => {
    const sections = [
        {
            title: '用户信息',
            content: `
                <p>本文档包含用户的基本信息和相关数据统计。所有数据均来自系统的实时统计，确保了数据的准确性和时效性。</p>
                <p>用户信息的收集和处理遵循相关的隐私保护法规，确保用户数据的安全性和保密性。</p>
            `,
            table: {
                headers: [
                    { text: '姓名', key: 'name' },
                    { text: '年龄', key: 'age' },
                    { text: '部门', key: 'department' },
                    { text: '入职时间', key: 'joinDate' }
                ],
                data: [
                    { name: '张三', age: 28, department: '技术部', joinDate: '2020-03-15' },
                    { name: '李四', age: 32, department: '市场部', joinDate: '2019-07-22' },
                    { name: '王五', age: 26, department: '设计部', joinDate: '2021-01-10' }
                ]
            }
        },
        {
            title: '数据统计',
            content: '<p>以下是各部门人员分布情况的统计数据：</p>',
            chart: {
                title: '部门人员分布图',
                dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
            }
        }
    ];

    advancedPrintManager.printDocument(sections, {
        title: '用户信息统计报告',
        pageSize: 'A4',
        margin: '2cm',
        orientation: 'portrait'
    });
});
```

## 7. 总结

通过本文的学习，我们深入了解了JavaScript的核心概念和实战技巧：

1. **事件循环机制**：理解了JavaScript单线程的本质，掌握了宏任务和微任务的执行顺序
2. **DOM操作**：学会了高效的DOM操作方法和事件委托技巧
3. **事件处理**：掌握了addEventListener的高级用法和自定义事件的创建
4. **正则表达式**：学会了实际开发中的正则应用，包括CSS单位转换和文本处理
5. **屏幕方向检测**：实现了完整的横竖屏检测和提示功能
6. **网页打印**：开发了功能完整的打印管理系统

这些知识和技能在实际开发中都非常实用，能够帮助我们构建更加健壮和用户友好的Web应用。建议在实际项目中多多实践这些技术，不断提升JavaScript开发能力。
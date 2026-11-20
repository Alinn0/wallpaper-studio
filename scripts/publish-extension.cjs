const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cli = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const authOnly = process.argv.includes('--check-auth');

function authHelp() {
    console.error(`
发布授权配置步骤（完成后重新运行任务）：
1. 打开 https://marketplace.visualstudio.com/manage ，确认当前账号有发布者 ${manifest.publisher} 的发布权限。
2. 按官方指南创建具有 Marketplace > Manage 权限的 PAT：
   https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token
3. 在本项目的 VS Code 终端执行：
   npx --no-install vsce login ${manifest.publisher}
   按提示在终端输入 PAT，不要将 Token 写入任务、源代码或聊天。
4. 执行 node scripts/publish-extension.cjs --check-auth 验证后，再运行发布任务。
也支持通过 VSCE_PAT 环境变量提供凭据。
若已登录仍验证失败，请检查 Token 是否过期、权限是否足够，以及网络连接。`);
}

function run(args, capture = false) {
    const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        env: process.env,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    if (result.error) throw result.error;
    return result;
}

function git(args) {
    const result = spawnSync('git', args, {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：\n${result.stderr || result.stdout}`);
    return result.stdout.trim();
}

function checkGit() {
    if (git(['status', '--porcelain'])) {
        throw new Error('存在未提交的文件。请先在 VS Code 源代码管理中检查并提交本次要发布的代码，再运行任务；尚未发布或递增版本。');
    }
    git(['var', 'GIT_AUTHOR_IDENT']);
    git(['var', 'GIT_COMMITTER_IDENT']);
    const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    let remote, ref;
    try {
        remote = git(['config', '--get', `branch.${branch}.remote`]);
        ref = git(['config', '--get', `branch.${branch}.merge`]);
        if (remote === '.' || !ref.startsWith('refs/heads/')) throw new Error('无效上游');
    } catch {
        throw new Error('当前分支没有远程上游。请先在 VS Code 源代码管理中“发布分支”，再运行任务。');
    }
    try {
        git(['push', '--dry-run', remote, `HEAD:${ref}`]);
    } catch (error) {
        throw new Error(`${error.message}\nGitHub 推送预检查失败，尚未发布。请先在 VS Code 登录 GitHub 并完成一次同步；如有远程更新，先拉取并解决冲突，再运行任务。`);
    }
    console.log(`发布后将推送到 ${remote}/${ref.slice('refs/heads/'.length)}。`);
    return { remote, ref };
}

try {
    if (!fs.existsSync(cli)) {
        throw new Error('缺少本地 vsce。请先执行 npm.cmd ci 和 npm.cmd --prefix webview ci，再重新运行任务。');
    }
    if (!manifest.publisher) throw new Error('package.json 缺少 publisher，请先配置扩展商店发布者 ID。');
    const target = authOnly ? null : checkGit();

    console.log(`检查发布者 ${manifest.publisher} 的凭据……`);
    if (!process.env.VSCE_PAT) {
        const publishers = run(['ls-publishers'], true);
        if (publishers.status !== 0 || !publishers.stdout.split(/\r?\n/).some(line => line.trim() === manifest.publisher)) {
            authHelp();
            throw new Error('未找到可用的已保存凭据。已停止，未编译、递增版本或发布。');
        }
    }
    if (run(['verify-pat', manifest.publisher]).status !== 0) {
        authHelp();
        throw new Error('授权验证未通过。已停止，未编译、递增版本或发布。');
    }
    if (!authOnly) {
        console.log(`开始编译并发布：${manifest.publisher}.${manifest.name}（当前 ${manifest.version}，自动递增 patch）。`);
        // vsce runs vscode:prepublish before bumping the version and uploading.
        if (run(['publish', 'patch', '--no-git-tag-version']).status !== 0) {
            const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
            throw new Error(`发布失败，当前本地版本为 ${current}。请查看上方错误；如版本已递增，请先核对商店状态再重试。确认该版本未发布时，可用 npx --no-install vsce publish --no-git-tag-version 重试当前版本，避免再次递增。`);
        }
        const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
        console.log(`扩展商店发布成功（${version}），正在提交版本号并推送代码……`);
        let committed = false;
        try {
            const versionFiles = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']
                .filter(file => fs.existsSync(path.join(root, file)));
            git(['add', '--', ...versionFiles]);
            git(['commit', '-m', `chore: release v${version}`, '--', ...versionFiles]);
            committed = true;
            git(['push', target.remote, `HEAD:${target.ref}`]);
        } catch (error) {
            throw new Error(`扩展商店已发布 ${version}，但 Git 同步失败：${error.message}\n不要重新运行发布任务，否则会再次递增版本。${committed ? '版本提交已保留，请在 VS Code 中推送当前分支以完成同步。' : '请检查并提交 package.json 和锁文件的版本改动，然后推送当前分支。'}`);
        }
        console.log('扩展商店发布及 GitHub 推送均已完成。商店可能需要等待验证和更新。');
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}

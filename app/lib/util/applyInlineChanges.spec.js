const assert = require('assert')
const { applyInlineChangesToContent } = require('./applyInlineChanges')

function run () {
  {
    const content = '- item\nnext'
    const result = applyInlineChangesToContent(content, [
      {
        line: 0,
        oldText: '',
        newText: '!',
        oldLineText: 'item',
        newLineText: 'item!'
      }
    ])
    assert.strictEqual(result.applied, 1)
    assert.strictEqual(result.content, '- item!\nnext')
  }

  {
    const content = '# title'
    const result = applyInlineChangesToContent(content, [
      {
        line: 0,
        oldText: '',
        newText: 'new ',
        oldLineText: 'title',
        newLineText: 'new title'
      }
    ])
    assert.strictEqual(result.applied, 1)
    assert.strictEqual(result.content, '# new title')
  }

  {
    const content = 'alpha beta'
    const result = applyInlineChangesToContent(content, [
      {
        line: 0,
        oldText: 'beta',
        newText: 'gamma'
      }
    ])
    assert.strictEqual(result.applied, 1)
    assert.strictEqual(result.content, 'alpha gamma')
  }

  {
    const content = '- item\r\n'
    const result = applyInlineChangesToContent(content, [
      {
        line: 0,
        oldText: '',
        newText: '!',
        oldLineText: 'item',
        newLineText: 'item!'
      }
    ])
    assert.strictEqual(result.applied, 1)
    assert.strictEqual(result.content, '- item!\r\n')
  }
}

if (require.main === module) {
  run()
  console.log('applyInlineChanges.spec: ok')
}

module.exports = {
  run
}

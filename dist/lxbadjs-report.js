var LXBJ_REPORT = (function(w, undefined) {
  if (w.LXBJ_REPORT) return w.LXBJ_REPORT

  var _log_list = [] // log list queue
  var _log_map = {} // log map used to check isRepeat
  var _config = {
    id: 0, // 上报id
    uin: 0, // user id
    url: '', // 上报接口
    offline_url: '', // 离线日志上报接口
    level: 4, // 错误级别 1-debug 2-info 4-error
    random: 1, // 抽样 (0-1] 1-全量
    delay: 1000, // 延迟(s)上报
    repeat: 3, // 重复上报次数(对于同一个错误超过多少次不上报),
    offlineLog: false, // 是否启用离线日志
    offlineLogExp: 1, // 离线日志过期时间 默认1天
    offlineLogAuto: false, // 是否自动上报离线日志
    alertLog: false, // 启用alertLog
    alertMsg: '' // 在alertLog中显示的message
  }

  // 离线储存使用index_DB
  var Offline_DB = {
    db: null,
    name: 'lxbj_db',
    version: 1,
    // 连接db
    ready: function(callback) {
      var self = this
      // 兼容检测
      if (!w.indexedDB || !_config.offlineLog) {
        return callback()
      }

      // db 已存在
      if (this.db) {
        setTimeout(function() {
          callback(null, self)
        }, 0)

        return
      }

      var request = w.indexedDB.open(Offline_DB.name, Offline_DB.version)

      if (!request) {
        return callback()
      }

      request.onerror = function(err) {
        callback(err)
        console.log('indexdb request error')
      }

      request.onsuccess = function(e) {
        self.db = e.target.result

        setTimeout(function() {
          callback(null, self)
        }, 1000)
      }

      request.onupgradeneeded = function(e) {
        var db = e.target.result

        if (!db.objectStoreNames.contains('logs')) {
          db.createObjectStore('logs', {
            autoIncrement: true // 索引自增
          });
        }
      }
    },

    // 连接store
    getStore: function() {
      var transaction = this.db.transaction('logs', 'readwrite')

      return transaction.objectStore('logs')
    },

    insertToDB: function(log) {
      var store = this.getStore()

      store.add(log)
    },

    // add log
    addLog: function(log) {
      if (!this.db) return

      this.insertToDB(log)
    },

    // add logs
    addLogs: function(logs) {
      if (!this.db) return

      logs.forEach(function(log) {
        this.addLog(log)
      }, this)
    },

    // get logs
    getLogs: function(opt, callback) {
      if (!this.db) return

      var store = this.getStore()
      // cursor 遍历
      var request = store.openCursor()
      var result = []

      request.onsuccess = function(event) {
        var cursor = event.target.result

        if (cursor) {
          var value = cursor.value
          if (value.time >= opt.start && value.time <= opt.end && value.id == opt.id && value.uin == opt.uin) {
            result.push(value)
            cursor['continue']()
          }
        } else {
          callback(null, result)
        }
      }
    },

    // clear db
    clearDB: function(daysToMainTain) {
      if (!this.db) return

      var store = this.getStore()

      if (!daysToMainTain) {
        store.clear()

        return
      }

      // 计算过期时间
      var range = +new Date() - (daysToMainTain || 2) * 1000 * 3600 * 24
      var request = store.openCursor()

      request.onsuccess = function(event) {
        var cursor = event.target.result

        if (cursor && (!cursor.value.time || cursor.value.time < range)) {
          store['delete'](cursor.primaryKey)
          cursor['continue']()
        }
      }
    }
  }

  // util
  var T = {
    isOBJByType: function(o, type) {
      return Object.prototype.toString.call(o) === '[object ' + (type || 'Object') + ']'
    },

    isOBJ: function(o) {
      return typeof o === 'object'
    },

    isEmpty: function(o) {
      if (o === null) return true
      if (this.isOBJByType(o, 'Number')) return false
      return !o
    },

    extend: function(src, source) {
      for (var key in source) {
        src[key] = source[key]
      }

      return src
    },

    // 格式化error.stack
    processStackMsg: function(err) {
      var stack = err.stack
        .replace(/\n/g, '') // 删除换行符
        .split(/\bat\b/) // at处分隔
        .slice(0, 5) // 取5层堆栈信息
        .join('@') // 用@分隔
        .replace(/\?[^:]+/gi, '') // 去除参数

      return stack
    },

    // 格式化error
    processError: function(errObj) {
      if (T.isOBJ(errObj) && errObj.stack) {
        var url = errObj.stack.match('(?:file|https?)://[^\n]+') // 获取url
        url = url ? url[0] : ''
        var rowCols = url.match(':(\\d+):(\\d+)') // 获取行列
        if (!rowCols) {
          rowCols = [0, 0, 0]
        }
        var stack = T.processStackMsg(errObj)

        return {
          msg: stack, // 格式化后的error.stack
          row: rowCols[1], // row number
          col: rowCols[2], // col number
          target: url.replace(rowCols[0], ''), // url without :row:col
          orgMsg: errObj.toString(), // origin message
          userAgent: window.navigator.userAgent
        }
      }
      return errObj
    },

    // 判断是否超过重复上报限制
    isRepeat: function(err) {
      if (!T.isOBJ(err)) return true

      var msg = err.msg
      var times = _log_map[msg] ? _log_map[msg] + 1 : 1

      return times > _config.repeat
    }
  }

  var orgError = w.onerror

  w.onerror = function(msg, url, row, col, error) {
    var newMsg = error && error.stack ? T.processStackMsg(error) : msg

    report.push({
      msg: newMsg,
      target: url,
      row: row,
      col: col,
      orgMsg: msg,
      userAgent: window.navigator.userAgent
    })

    _process_log()

    orgError && orgError.apply(w, arguments)
  }

  // 格式化log信息
  var _report_log_tostring = function(err, index) {
    var param = []
    var params = []
    var stringify = []

    if (T.isOBJ(err)) {
      err.level = err.level || _config.level

      for (var key in err) {
        var value = err[key]

        if (!T.isEmpty(value)) {
          if (T.isOBJ(value)) {
            value = JSON.stringify(value)
          }

          stringify.push(key + ':' + value) // without combo (not use)
          param.push(key + '=' + encodeURIComponent(value)) // ignore (not use)
          params.push(key + '[' + index + ']=' + encodeURIComponent(value)) // combo
        }
      }
    }

    // 格式
    // msg[0]=msg&target[0]=target -- combo report
    // msg:msg,target:target -- ignore
    // msg=msg&target=target -- report without combo
    return [params.join('&'), stringify.join(','), param.join('&')]
  }

  // 存入离线日志
  var _offline_buffer = []
  var _saveToOffline = function(msgObj) {
    // 给msgObj添加额外信息
    msgObj = T.extend({
      id: _config.id,
      uin: _config.uin,
      time: +new Date()
    }, msgObj)

    // 若数据库已初始化
    if (Offline_DB.db) {
      Offline_DB.addLog(msgObj)
      return
    }

    // 否则初始化
    if (!Offline_DB.db && !_offline_buffer.length) {
      Offline_DB.ready(function(err, db) {
        if (db && _offline_buffer.length) {
          db.addLogs(_offline_buffer)
          _offline_buffer = []
        }
      })
    }

    _offline_buffer.push(msgObj) // 存入缓冲区
  }

  var submit_log_list = []
  var comboTimeout = 0

  // 普通上报
  var _submit_log = function() {
    clearTimeout(comboTimeout)

    comboTimeout = 0

    if (!submit_log_list.length) return

    var url = _config._reportUrl + submit_log_list.join("&") + "&count=" + submit_log_list.length + "&_t=" + (+new Date)

    var _img = new Image()
    _img.src = url

    submit_log_list = []
  }

  var alert_log_list = []

  // 流程上报
  var _process_log = function(isReportNow) {
    if (!_config._reportUrl) return

    // 取随机数决定是否上报
    var randomIgnore = Math.random() >= _config.random

    while (_log_list.length) {
      var report_log = _log_list.shift()
      // 有效字符300
      report_log.msg = (report_log.msg + '' || '').substr(0, 500)
      // 判断重复上报
      if (T.isRepeat(report_log)) continue
      // 格式化log信息
      var log_str = _report_log_tostring(report_log, submit_log_list.length)
      // 若离线日志开启 则存入db
      _config.offlineLog && _saveToOffline(report_log)
      // 若上报方式为_offline_log 则不上报
      if (!randomIgnore && report_log.level && report_log.level !== 20) {
        // 推入submit_log_list等待被上报
        submit_log_list.push(log_str[0]);
        _config.alertLog && alert_log_list.push(report_log)
      }
    }

    if (isReportNow) {
      // 立即上报
      _submit_log()
    } else if (!comboTimeout) {
      // 延迟上报 (防抖)
      comboTimeout = setTimeout(function() {
        _submit_log()
        window.alert(_config.alertMsg + JSON.stringify(alert_log_list))
      }, _config.delay)
    }
  }

  report = w.LXBJ_REPORT = {
    push: function(msg) {
      var data = T.isOBJ(msg) ? T.processError(msg) : {
        msg: msg
      }

      if (!data.from) {
        data.from = window.location.href
      }

      _log_list.push(data)

      _process_log()

      return report
    },

    // 立即上报
    report: function(msg, isReportNow) {
      msg && report.push(msg)
      isReportNow && _process_log(true)

      return report
    },

    // info 上报
    info: function(msg) {
      if (!msg) return report

      if (T.isOBJ(msg)) {
        msg.level = 2
      } else {
        msg = {
          msg: msg,
          level: 2
        }
      }

      report.push(msg)

      return report
    },

    // debug 上报
    debug: function(msg) {
      if (!msg) return report

      if (T.isOBJ(msg)) {
        msg.level = 1
      } else {
        msg = {
          msg: msg,
          level: 1
        }
      }

      report.push(msg)

      return report
    },

    // 上报离线日志
    reportOfflineLog: function() {
      if (!window.indexedDB) {
        report.info('not support offline log')
        return
      }

      Offline_DB.ready(function(err, db) {
        if (!db) return

        var startDate = +new Date - _config.offlineLogExp * 1000 * 3600 * 24
        var endDate = +new Date

        db.getLogs({
          start: startDate,
          end: endDate,
          id: _config.id,
          uin: _config.uin
        }, function(err, result) {
          var iframe = document.createElement('iframe')
          iframe.name = 'lxbadjs_offline_' + (+new Date)
          iframe.frameborder = 0
          iframe.width = 0
          iframe.height = 0
          iframe.src = 'javascript:false'

          iframe.onload = function() {
            var form = document.createElement('form')
            form.style.display = 'none'
            form.target = iframe.name
            form.method = 'POST'
            form.action = _config.offline_url
            form.enctype.method = 'multipart/form-data'

            var input = document.createElement('input')
            input.style.display = 'none'
            input.type = 'hidden'
            input.name = 'offline_log'
            input.value = JSON.stringify({
              logs: result,
              startDate: startDate,
              endDate: endDate,
              id: _config.id,
              uin: _config.uin,
              userAgent: window.navigator.userAgent
            })

            form.appendChild(input)
            iframe.contentDocument.body.appendChild(form)

            form.submit()

            setTimeout(function() {
              document.body.removeChild(iframe)
            }, 10000)

            iframe.onload = null
          }

          document.body.appendChild(iframe)
        })
      })
    },

    // 记录离线日志 但不上报
    offlineLog: function(msg) {
      if (!msg) return report

      if (T.isOBJ(msg)) {
        msg.level = 20
      } else {
        msg = {
          msg: msg,
          level: 20
        }
      }

      report.push(msg)

      return report
    },

    // init
    init: function(cfg) {
      if (T.isOBJ(cfg)) {
        T.extend(_config, cfg)
      }

      _config._reportUrl = _config.url + '?id=' + _config.id + '&uin=' + _config.uin + '&'

      // _log_list有内容先上报
      if (_log_list.length) {
        _process_log()
      }

      if (!Offline_DB._initing) {
        Offline_DB._initing = true
        Offline_DB.ready(function(err, db) {
          if (db) {
            setTimeout(function() {
              db.clearDB(_config.offlineLogExp)
              setTimeout(function() {
                _config.offlineLogAuto && report.reportOfflineLog()
              }, 5000)
            }, 1000)
          }
        })
      }

      return report
    }

  }

  return report

})(window)
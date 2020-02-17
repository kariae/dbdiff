var _ = require('underscore')
var util = require('util')
var dialects = require('./dialects')
var dedent = require('dedent')

class DbDiff {
  _log (sql, level) {
    this.sql.push({ sql, level })
  }

  _drop (sql) {
    this._log(sql, 3)
  }

  _warn (sql) {
    this._log(sql, 2)
  }

  _safe (sql) {
    this._log(sql, 1)
  }

  _comment (sql) {
    this._log(sql, 0)
  }

  _quote (name) {
    return this._quotation + name + this._quotation
  }

  _compareTables (table1, table2) {
    var tableName = this._fullName(table1)

    var columNames1 = this._columnNames(table1)
    var columNames2 = this._columnNames(table2)

    var diff1 = _.difference(columNames1, columNames2)
    var diff2 = _.difference(columNames2, columNames1)

    diff1.forEach((columnName) => {
      this._drop(`ALTER TABLE ${tableName} DROP COLUMN ${this._quote(columnName)};`)
    })

    diff2.forEach((columnName) => {
      var col = table2.columns.find((column) => column.name === columnName)
      this._safe(`ALTER TABLE ${tableName} ADD COLUMN ${this._quote(columnName)} ${this._columnDescription(col)};`)
    })

    var common = _.intersection(columNames1, columNames2)
    common.forEach((columnName) => {
      var col1 = table1.columns.find((column) => column.name === columnName)
      var col2 = table2.columns.find((column) => column.name === columnName)

      if (this._dialect === 'mysql' && !_.isEqual(col1, col2)) {
        var func = (col1.type !== col2.type || (col1.nullable !== col2.nullable && !col2.nullable)) ? this._warn : this._safe
        var extra = col2.extra ? ' ' + col2.extra : ''
        var comment = col1.type !== col2.type ? `-- Previous data type was ${col1.type}\n` : ''
        func.bind(this)(`${comment}ALTER TABLE ${tableName} MODIFY ${this._quote(columnName)} ${this._columnDescription(col2)}${extra};`)
        return
      }
      if (col1.type !== col2.type) {
        this._warn(dedent`
          -- Previous data type was ${col1.type}
          ALTER TABLE ${tableName} ALTER COLUMN ${this._quote(columnName)} SET DATA TYPE ${col2.type};
        `)
      }
      if (col1.nullable !== col2.nullable) {
        if (col2.nullable) {
          this._safe(`ALTER TABLE ${tableName} ALTER COLUMN ${this._quote(columnName)} DROP NOT NULL;`)
        } else {
          this._warn(`ALTER TABLE ${tableName} ALTER COLUMN ${this._quote(columnName)} SET NOT NULL;`)
        }
      }
    })
  }

  _createIndex (table, index) {
    var tableName = this._fullName(table)
    var keys = index.columns.map((key) => `${this._quote(key)}`).join(',')
    if (this._dialect === 'postgres') {
      this._safe(`CREATE INDEX ${this._quote(index.name)} ON ${tableName} USING ${index.type} (${keys})${(index.predicate)? ` WHERE ${index.predicate}` : ''};`)
    } else {
      // mysql
      this._safe(`CREATE INDEX ${this._quote(index.name)} USING ${index.type} ON ${tableName} (${keys});`)
    }
  }

  _dropIndex (table, index) {
    if (this._dialect === 'postgres') {
      this._safe(`DROP INDEX ${this._fullName(index)};`)
    } else {
      this._safe(`DROP INDEX ${this._fullName(index)} ON ${this._fullName(table)};`)
    }
  }

  _compareIndexes (table1, table2) {
    var indexNames1 = this._indexNames(table1)
    var indexNames2 = this._indexNames(table2)

    var diff1 = _.difference(indexNames1, indexNames2)
    var diff2 = _.difference(indexNames2, indexNames1)

    if (diff1.length > 0) {
      diff1.forEach((indexName) => {
        var index = table1.indexes.find((index) => index.name === indexName)
        this._dropIndex(table1, index)
      })
    }
    if (diff2.length > 0) {
      diff2.forEach((indexName) => {
        var index = table2.indexes.find((index) => index.name === indexName)
        this._createIndex(table2, index)
      })
    }

    var inter = _.intersection(indexNames1, indexNames2)
    inter.forEach((indexName) => {
      var index1 = table1.indexes.find((index) => index.name === indexName)
      var index2 = table2.indexes.find((index) => index.name === indexName)

      if (_.difference(index1.columns, index2.columns).length > 0 ||
        index1.primary !== index2.primary ||
        index1.unique !== index2.unique) {
        var index = index2
        this._comment(`-- Index ${this._fullName(index)} needs to be changed`)
        this._dropIndex(table1, index)
        this._createIndex(table1, index)
      }
    })
  }

  _compareSequences (db1, db2) {
    var sequenceNames1 = this._sequenceNames(db1)
    var sequenceNames2 = this._sequenceNames(db2)

    var diff1 = _.difference(sequenceNames1, sequenceNames2)
    var diff2 = _.difference(sequenceNames2, sequenceNames1)

    diff1.forEach((sequenceName) => {
      this._safe(`DROP SEQUENCE IF EXISTS ${sequenceName} CASCADE;`)
    })

    diff2.forEach((sequenceName) => {
      var sequence = db2.sequences.find((sequence) => sequenceName === this._fullName(sequence))
      this._safe(this._sequenceDescription(sequence))
    })

    var inter = _.intersection(sequenceNames1, sequenceNames2)
    inter.forEach((sequenceName) => {
      var sequence1 = db1.sequences.find((sequence) => sequenceName === this._fullName(sequence))
      var sequence2 = db2.sequences.find((sequence) => sequenceName === this._fullName(sequence))

      var desc1 = this._sequenceDescription(sequence1)
      var desc2 = this._sequenceDescription(sequence2)

      if (desc2 !== desc1) {
        this._safe(`DROP SEQUENCE IF EXISTS ${sequenceName}; CASCADE`)
        this._safe(desc2)
      }
    })
  }

  _compareConstraints (table1, table2) {
    var constraints = []
    var tableName = this._fullName(table2)
    table2.constraints.forEach((constraint2) => {
        var table2Name = this._fullNameFromConstraints(constraint2)
        var constraint1 = table1 && table1.constraints.find((cons) => constraint2.name === cons.name)
        if (constraint1) {
          if (_.isEqual(constraint1, constraint2)) return
          if (this._dialect === 'postgres') {
            this._safe(`ALTER TABLE ${tableName} DROP CONSTRAINT ${this._quote(constraint2.name)};`)
          } else {
            this._safe(`ALTER TABLE ${tableName} DROP INDEX ${this._quote(constraint2.name)};`)
          }
          constraint1 = null
        }
        if (!constraint1) {
          var keys = constraint2.columns.map((s) => `${this._quote(s)}`).join(', ')
          var func = (table1 ? this._warn : this._safe).bind(this)
          var fullName = this._quote(constraint2.name)
          if (constraint2.type === 'primary') {
            if (this._dialect === 'mysql') fullName = 'foo'
            constraints.push({
              func,
              order: 1,
              sql: `ALTER TABLE ${tableName} ADD CONSTRAINT ${fullName} PRIMARY KEY (${keys});`,
            })
          } else if (constraint2.type === 'unique') {
            constraints.push({
              func,
              order: 2,
              sql: `ALTER TABLE ${tableName} ADD CONSTRAINT ${fullName} UNIQUE (${keys});`,
            })
          } else if (constraint2.type === 'foreign') {
            var foreignKeys = constraint2.referenced_columns.map((s) => `${this._quote(s)}`).join(', ')
            constraints.push({
              func,
              order: 3,
              sql: `ALTER TABLE ${tableName} ADD CONSTRAINT ${fullName} FOREIGN KEY (${keys}) REFERENCES ${table2Name} (${foreignKeys});`,
            })
          }
        }
    })

    return constraints
  }

  compareSchemas (db1, db2) {
    this.sql = []
    this._dialect = db1.dialect
    this._quotation = {
      mysql: '`',
      postgres: '"'
    }[this._dialect]
    var schemaFromDb1 = [...new Set(db1.tables.map((table) => table.schema))]
    var schemaFromDb2 = [...new Set(db2.tables.map((table) => table.schema))]

    schemaFromDb1.forEach((schema) => {
      var s = this._findSchema(schemaFromDb2, schema)
      if (!s) {
          this._drop(`DROP SCHEMA IF EXISTS ${this._quote(schema)} CASCADE;`)
      }
    })

    schemaFromDb2.forEach((schema) => {
      var s = this._findSchema(schemaFromDb1, schema)
      if (!s) {
        this._safe(`CREATE SCHEMA IF NOT EXISTS ${this._quote(schema)};`)
      }
    })

    this._compareSequences(db1, db2)

    db1.tables.forEach((table) => {
      var t = this._findTable(db2, table)
      if (!t) {
        this._drop(`DROP TABLE IF EXISTS ${this._fullName(table)} CASCADE;`)
      }
    })

    db2.tables.forEach((table) => {
      var t = this._findTable(db1, table)
      var tableName = this._fullName(table)
      if (!t) {
        var columns = table.columns.map((col) => {
          var extra = ''
          if (col.extra === 'auto_increment') {
            extra = ' PRIMARY KEY AUTO_INCREMENT'
            var constraint = table.constraints.find((constraints) => constraints.type === 'primary')
            table.constraints.splice(table.constraints.indexOf(constraint), 1)
          }
          return `\n  ${this._quote(col.name)} ${this._columnDescription(col)}${extra}`
        })
        this._safe(`CREATE TABLE ${tableName} (${columns.join(',')}\n);`)

        var indexNames2 = this._indexNames(table)
        indexNames2.forEach((indexName) => {
          var index = table.indexes.find((index) => index.name === indexName)
          this._createIndex(table, index)
        })
      } else {
        this._compareTables(t, table)
        this._compareIndexes(t, table)
      }
    })

    var constraints = []
    db2.tables.forEach((table) => {
      var t = this._findTable(db1, table)
      constraints = constraints.concat(this._compareConstraints(t, table))
    })

    // execute add constraints after ordering since we should add primary and unqiue keys before foreign ones
    for (var constraint of constraints.sort((a, b) => a.order - b.order)) {
      constraint.func(constraint.sql)
    }
  }

  compare (conn1, conn2, closeAfter = false) {
    return Promise.all([
      dialects.describeDatabase(conn1, closeAfter),
      dialects.describeDatabase(conn2, closeAfter)
    ])
    .then((results) => {
      var db1 = results[0]
      var db2 = results[1]
      this.compareSchemas(db1, db2)
    })
  }

  _commentOut (sql) {
    return sql.split('\n').map((line) => line.substring(0, 2) === '--' ? line : `-- ${line}`).join('\n')
  }

  _columnNames (table) {
    return table.columns.map((col) => col.name).sort()
  }

  _columnDescription (col) {
    var desc = col.type
    if (col.default_value != null) {
      desc += ' DEFAULT ' + col.default_value
    }
    desc += col.nullable ? ' NULL' : ' NOT NULL'
    return desc
  }

  _indexNames (table) {
    return table.indexes.map((index) => index.name).sort()
  }

  _isNumber (n) {
    return +n == n // eslint-disable-line
  }

  _sequenceDescription (sequence) {
    return util.format('CREATE SEQUENCE %s INCREMENT %s %s %s %s %s CYCLE;',
      this._fullName(sequence),
      sequence.increment,
      this._isNumber(sequence.minimum_value) ? 'MINVALUE ' + sequence.minimum_value : 'NO MINVALUE',
      this._isNumber(sequence.maximum_value) ? 'MAXVALUE ' + sequence.maximum_value : 'NO MAXVALUE',
      this._isNumber(sequence.start_value) ? 'START ' + sequence.start_value : '',
      sequence.cycle ? '' : 'NO'
    )
  }

  _sequenceNames (db) {
    return db.sequences.map((sequence) => this._fullName(sequence))
  }

  _fullName (obj) {
    if (obj.schema) return `${this._quote(obj.schema)}.${this._quote(obj.name)}`
    return this._quote(obj.name)
  }

  _fullNameFromConstraints (obj) {
    if (obj.schema) return `${this._quote(obj.referenced_table_schema)}.${this._quote(obj.referenced_table)}`
    return this._quote(obj.referenced_table)
  }

  _findTable (db, table) {
    return db.tables.find((t) => t.name === table.name && t.schema === table.schema)
  }

  _findSchema (schemas, schema) {
    return schemas.includes(schema)
  }

  commands (type) {
    var level = 1
    if (type === 'drop') level = 3
    else if (type === 'warn') level = 2
    return this.sql.map((sql) => {
      return sql.level > level
        ? this._commentOut(sql.sql)
        : sql.sql
    }).join('\n\n')
  }
}

module.exports = DbDiff
